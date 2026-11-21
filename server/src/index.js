// Serwer-sędzia „Zgadnij Klatkę”.
// Każdy pokój to Durable Object: losuje film, trzyma odpowiedź, sprawdza strzały i liczy punkty.
// Przeglądarki dostają tylko stan publiczny. Wybierający dostaje jeszcze id filmu, żeby załadować player
// i złapać klatkę — nic więcej. Nikt, łącznie z twórcą pokoju, nie zna odpowiedzi przed odkryciem.
import { DurableObject } from 'cloudflare:workers';

const MAX_PLAYERS = 12;
const MAX_TRIES = 3;          // trafienie za 1. razem = 3 pkt, za 2. = 2 pkt, za 3. = 1 pkt
const MIN_HUMAN_MS = 1200;    // szybszy „strzał” od pokazania klatki to nie człowiek
const CHEAT_PENALTY = 3;
const AUTO_NEXT_S = 10;       // po odkryciu następna tura rusza sama
const ROOM_TTL_MS = 24 * 3600e3; // pusty pokój znika po dobie
const MAX_FRAME = 1_100_000;  // klatka jako data URL (JPEG ~1280 px) mieści się z zapasem

const MODES = {race: 1, own: 1};
const POOLS = {
  known:    {q: {sort_by: 'vote_count.desc'}, pages: [1, 25]},
  harder:   {q: {sort_by: 'vote_count.desc'}, pages: [26, 100]},
  pl:       {q: {sort_by: 'vote_count.desc', with_original_language: 'pl'}, pages: [1, 8]},
  classics: {q: {sort_by: 'vote_count.desc', 'primary_release_date.lte': '1999-12-31'}, pages: [1, 15]},
  recent:   {q: {sort_by: 'vote_count.desc', 'primary_release_date.gte': '2020-01-01'}, pages: [1, 10]},
};

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, ' ').trim();
const json = (o, headers = {}, status = 200) => new Response(JSON.stringify(o), {status, headers: {...headers, 'Content-Type': 'application/json'}});

// ================= TMDB (klucz tylko na serwerze) =================
async function tmdb(env, path, params = {}){
  const u = new URL('https://api.themoviedb.org/3' + path);
  u.searchParams.set('api_key', env.TMDB_KEY);
  u.searchParams.set('language', 'pl-PL');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, {cf: {cacheTtl: 3600, cacheEverything: true}});
  if (!r.ok) throw new Error('TMDB ' + r.status);
  return r.json();
}
// Bez napisów: odcinamy początek (logo, napisy początkowe) i koniec (napisy końcowe)
function rangeFor(runtimeMin){
  const R = (runtimeMin || 0) * 60;
  if (!R) return {min: 150, max: 2 * 3600};
  const min = Math.min(150, Math.floor(R * 0.1));
  const max = Math.floor(R - Math.max(300, R * 0.07));
  return {min, max: Math.max(min + 60, max)};
}
async function drawFilm(env, pool){
  const p = POOLS[pool] || POOLS.known;
  // tylko filmy, które wyszły co najmniej ~4 miesiące temu (są już w playerach) i mają trochę ocen
  const cutoff = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  for (let tries = 0; tries < 8; tries++) {
    const page = p.pages[0] + Math.floor(Math.random() * (p.pages[1] - p.pages[0] + 1));
    const list = ((await tmdb(env, '/discover/movie', Object.assign({page, include_adult: false}, p.q))).results || [])
      .filter(m => !m.adult && m.release_date && m.release_date <= cutoff && m.vote_count >= (pool === 'pl' ? 30 : 100));
    if (!list.length) continue;
    const pick = list[Math.floor(Math.random() * list.length)];
    const f = await tmdb(env, '/movie/' + pick.id, {append_to_response: 'credits'});
    if (f.runtime && f.runtime < 40) continue;
    return {id: f.id, title: f.title, original_title: f.original_title, runtime: f.runtime, release_date: f.release_date,
            genres: (f.genres || []).map(g => g.name), overview: f.overview, poster_path: f.poster_path, tagline: f.tagline,
            cast: (f.credits?.cast || []).slice(0, 3).map(c => c.name), director: (f.credits?.crew || []).find(c => c.job === 'Director')?.name};
  }
  throw new Error('nie udało się wylosować');
}
function buildHints(f){
  return [
    f.release_date && '📅 ' + f.release_date.slice(0, 4),
    f.genres?.length && '🎭 ' + f.genres.join(', '),
    f.cast?.[0] && '⭐ ' + f.cast[0],
    f.director && '🎬 reż. ' + f.director,
    f.cast?.[1] && '⭐ ' + f.cast[1],
    f.tagline && '💬 „' + f.tagline + '”',
  ].filter(Boolean);
}

// ================= Worker: WebSocket do pokoju + podpowiedzi tytułów =================
export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin) ? {'Access-Control-Allow-Origin': origin, 'Vary': 'Origin'} : {};
    if (req.method === 'OPTIONS') return new Response(null, {headers: {...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400'}});

    const ws = url.pathname.match(/^\/ws\/([A-Z2-9]{5})$/);
    if (ws) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', {status: 426});
      if (!allowed.includes(origin)) return new Response('forbidden', {status: 403});
      return env.ROOMS.get(env.ROOMS.idFromName(ws[1])).fetch(req);
    }
    // podpowiedzi przy wpisywaniu tytułu (klucz TMDB zostaje tutaj)
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      if (!q) return json({results: []}, cors);
      try {
        const r = await tmdb(env, '/search/movie', {query: q});
        return json({results: (r.results || []).slice(0, 20).map(m => ({id: m.id, title: m.title, original_title: m.original_title, release_date: m.release_date, poster_path: m.poster_path, vote_count: m.vote_count}))}, cors);
      } catch (e) { return json({results: [], error: e.message}, cors, 502) }
    }
    // awaryjny kadr z TMDB dla wybierającego, gdy player nie działa
    const im = url.pathname.match(/^\/api\/images\/(\d{1,9})$/);
    if (im) {
      try {
        const r = await tmdb(env, '/movie/' + im[1] + '/images', {include_image_language: 'null'});
        return json({backdrops: (r.backdrops || []).map(b => ({file_path: b.file_path, iso_639_1: b.iso_639_1}))}, cors);
      } catch (e) { return json({backdrops: [], error: e.message}, cors, 502) }
    }
    return new Response('Zgadnij Klatkę – serwer gry', {headers: cors});
  }
};

// ================= Pokój =================
const newRoom = code => ({
  code, createdAt: Date.now(), lastActive: Date.now(), hostId: null, players: [], tokens: {},
  round: 0, turn: 0, phase: 'lobby', pickerId: null, guesserId: null, triesBy: {},
  film: null, hints: [], hintPool: [], feed: [], reveal: null, frameNote: '', frameAt: null,
  nextAt: null, cheater: null, settings: {pool: 'known', mode: 'race'}, ver: 0,
});

export class Room extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.drawing = false;
    ctx.blockConcurrencyWhile(async () => {
      this.r = (await ctx.storage.get('room')) || null;
      this.frame = (await ctx.storage.get('frame')) || null;
    });
    // „ping” od przeglądarki trzyma połączenie bez budzenia pokoju
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req){
    const url = new URL(req.url);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({pid: null, code: url.pathname.slice(4), create: url.searchParams.get('create') === '1'});
    return new Response(null, {status: 101, webSocket: client});
  }

  // ---------- wysyłanie ----------
  sockets(pid){ return this.ctx.getWebSockets().filter(w => { const a = w.deserializeAttachment(); return a?.pid && (!pid || a.pid === pid) }) }
  sendTo(ws, obj){ try { ws.send(JSON.stringify(obj)) } catch {} }
  sendPlayer(pid, obj){ const s = JSON.stringify(obj); for (const w of this.sockets(pid)) try { w.send(s) } catch {} }
  hostId(){ // twórca pokoju, a gdy wyjdzie — pierwszy obecny gracz
    const r = this.r, h = r.players.find(p => p.id === r.hostId);
    return h?.online ? h.id : (r.players.find(p => p.online)?.id || r.hostId);
  }
  pub(){
    const r = this.r;
    return {players: r.players, hostId: this.hostId(), round: r.round, turn: r.turn, phase: r.phase, pickerId: r.pickerId,
            hints: r.hints, hintsLeft: r.hintPool.length - r.hints.length, feed: r.feed.slice(-40), reveal: r.reveal,
            frameNote: r.frameNote, settings: r.settings, guesserId: r.guesserId, triesBy: r.triesBy,
            nextIn: r.nextAt ? Math.max(0, Math.ceil((r.nextAt - Date.now()) / 1000)) : null,
            cheater: r.cheater, ver: ++r.ver};
  }
  async broadcast(){
    const s = JSON.stringify({t: 'state', s: this.pub()});
    for (const w of this.sockets()) try { w.send(s) } catch {}
    this.r.lastActive = Date.now();
    await this.ctx.storage.put('room', this.r);
  }
  sendFrameAll(){ const s = JSON.stringify({t: 'frame', turn: this.r.turn, img: this.frame}); for (const w of this.sockets()) try { w.send(s) } catch {} }
  filmFor(){ const f = this.r.film; return f && {id: f.id, runtime: f.runtime || null, range: rangeFor(f.runtime)} } // tylko tyle dostaje wybierający

  // ---------- połączenia ----------
  async webSocketMessage(ws, raw){
    if (typeof raw !== 'string' || raw.length > MAX_FRAME + 2000) return;
    const a = ws.deserializeAttachment() || {};
    const now = Date.now(); // prosty limit: >15 wiadomości na sekundę z jednego połączenia ignorujemy
    if (now - (a.winAt || 0) > 1000) { a.winAt = now; a.win = 0 }
    if (++a.win > 15) { ws.serializeAttachment(a); return }
    ws.serializeAttachment(a);
    let m; try { m = JSON.parse(raw) } catch { return }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') return this.hello(ws, a, m);
    if (!a.pid || !this.r) return;
    const pl = this.r.players.find(p => p.id === a.pid);
    if (pl) await this.handle(pl, m);
  }
  async webSocketClose(ws, code){ try { ws.close(1000, 'bye') } catch {} await this.dropped(ws) }
  async webSocketError(ws){ await this.dropped(ws) }
  async dropped(ws){
    const a = ws.deserializeAttachment();
    if (!this.r) return;
    const others = this.ctx.getWebSockets().filter(w => w !== ws);
    if (a?.pid && !others.some(w => w.deserializeAttachment()?.pid === a.pid)) {
      const pl = this.r.players.find(p => p.id === a.pid);
      if (pl?.online) { pl.online = false; this.markLeft(pl); await this.broadcast() }
    }
    if (!others.length) await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS); // pusty pokój posprząta się sam
  }

  async hello(ws, a, m){
    if (a.pid) return;
    const fail = (code, text) => { this.sendTo(ws, {t: 'error', code, text}); try { ws.close(4000, code) } catch {} };
    if (!this.r) {
      if (!a.create) return fail('noroom', 'Nie ma takiego pokoju (albo już wygasł).');
      this.r = newRoom(a.code);
    }
    const r = this.r;
    let token = typeof m.token === 'string' ? m.token : null;
    let pl = token && r.tokens[token] ? r.players.find(p => p.id === r.tokens[token]) : null;
    if (!pl) {
      if (a.create && r.players.length) return fail('exists', 'Ten kod jest zajęty.');
      if (r.players.length >= MAX_PLAYERS) return fail('full', 'Pokój jest pełny.');
      let name = String(m.name || 'Gracz').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Gracz';
      for (let i = 2; r.players.some(p => p.name === name); i++) name = name.slice(0, 17) + ' ' + i;
      pl = {id: 'p_' + crypto.randomUUID().slice(0, 8), name, pts: 0, online: true, cheats: 0};
      token = crypto.randomUUID();
      r.tokens[token] = pl.id;
      r.players.push(pl);
      if (!r.hostId) r.hostId = pl.id;
    }
    pl.online = true;
    a.pid = pl.id; ws.serializeAttachment(a);
    this.sendTo(ws, {t: 'welcome', you: pl.id, token});
    if (pl.id === r.pickerId && r.phase === 'time') this.sendTo(ws, {t: 'film', turn: r.turn, film: this.filmFor()});
    this.sendTo(ws, {t: 'frame', turn: r.turn, img: this.frame});
    await this.broadcast();
    if (r.phase === 'reveal' && r.nextAt) await this.ctx.storage.setAlarm(Math.max(Date.now() + 500, r.nextAt));
  }

  // ---------- logika gry ----------
  markLeft(p){
    const r = this.r;
    if (r.pickerId === p.id && (r.phase === 'draw' || r.phase === 'time')) r.feed.push({sys: true, text: p.name + ' wyszedł — host może powtórzyć turę albo przejść dalej.'});
  }
  nextPicker(){
    const online = this.r.players.filter(p => p.online);
    if (!online.length) return null;
    const i = online.findIndex(p => p.id === this.r.pickerId);
    return online[(i + 1) % online.length].id;
  }
  newTurn(pickerId){
    const r = this.r;
    r.turn++;
    Object.assign(r, {phase: pickerId ? 'draw' : 'lobby', pickerId, guesserId: r.settings.mode === 'own' ? pickerId : null, triesBy: {},
                      film: null, hints: [], hintPool: [], feed: [], reveal: null, frameNote: '', frameAt: null, nextAt: null, cheater: null});
    this.frame = null;
    this.ctx.storage.delete('frame');
    this.sendFrameAll();
  }
  async reveal(winner){
    const r = this.r, f = r.film;
    r.phase = 'reveal';
    r.reveal = {title: f.title, original_title: f.original_title, year: (f.release_date || '').slice(0, 4), poster: f.poster_path, overview: f.overview, winner};
    if (!winner && !r.guesserId) r.feed.push({sys: true, text: 'Nikt nie zgadł.'});
    r.nextAt = Date.now() + AUTO_NEXT_S * 1000;
    await this.ctx.storage.setAlarm(r.nextAt);
  }
  async alarm(){
    const r = this.r;
    if (!r) return;
    if (r.phase === 'reveal' && r.nextAt && Date.now() >= r.nextAt - 200) { r.round++; this.newTurn(this.nextPicker()); await this.broadcast() }
    if (!this.ctx.getWebSockets().length) {
      if (Date.now() - r.lastActive >= ROOM_TTL_MS - 60e3) { await this.ctx.storage.deleteAll(); this.r = null; this.frame = null }
      else await this.ctx.storage.setAlarm(r.lastActive + ROOM_TTL_MS);
    }
  }

  async handle(pl, m){
    const r = this.r, isHost = pl.id === this.hostId();
    switch (m.t){
      case 'start':
        if (isHost && r.phase === 'lobby') { r.round = 1; this.newTurn(r.players.find(p => p.online)?.id || null); await this.broadcast() }
        break;
      case 'settings':
        if (!isHost) return;
        r.settings = {pool: POOLS[m.settings?.pool] ? m.settings.pool : 'known', mode: MODES[m.settings?.mode] ? m.settings.mode : 'race'};
        if (r.phase === 'lobby') r.guesserId = null;
        else if (r.phase === 'draw' || r.phase === 'time') r.guesserId = r.settings.mode === 'own' ? r.pickerId : null;
        await this.broadcast();
        break;
      case 'draw': { // losuje serwer; wybierający dostaje tylko id i długość filmu
        if (pl.id !== r.pickerId || r.phase !== 'draw' || this.drawing) return;
        this.drawing = true;
        const turn = r.turn;
        let film;
        try { film = await drawFilm(this.env, r.settings.pool) }
        catch (e) { this.sendPlayer(pl.id, {t: 'error', code: 'draw', text: 'Błąd losowania: ' + e.message}); return }
        finally { this.drawing = false }
        if (r.turn !== turn || r.phase !== 'draw') return; // w międzyczasie host powtórzył albo pominął turę
        r.film = film; r.hintPool = buildHints(film); r.phase = 'time';
        r.feed.push({sys: true, text: pl.name + ' wylosował film. Teraz wybiera moment.'});
        this.sendPlayer(pl.id, {t: 'film', turn: r.turn, film: this.filmFor()}); // przed stanem, żeby wybierający miał już długość filmu
        await this.broadcast();
        break;
      }
      case 'frame': {
        if (pl.id !== r.pickerId || r.phase !== 'time' || typeof m.img !== 'string' || m.img.length > MAX_FRAME) return;
        if (!/^(data:image\/(jpeg|png|webp);base64,|https:\/\/image\.tmdb\.org\/t\/p\/)/.test(m.img)) return;
        this.frame = m.img;
        await this.ctx.storage.put('frame', m.img);
        r.frameNote = String(m.note || '').slice(0, 200);
        r.phase = 'guess';
        r.frameAt = Date.now(); // od tej chwili liczymy czas reakcji
        this.sendFrameAll();
        await this.broadcast();
        break;
      }
      case 'guess': {
        if (r.phase !== 'guess' || !r.film) return;
        if (r.guesserId ? pl.id !== r.guesserId : pl.id === r.pickerId) return; // wybierający zna film, więc nie zgaduje (poza trybem „swój film”)
        const used = r.triesBy[pl.id] || 0;
        if (used >= MAX_TRIES) return;
        const text = String(m.text || '').slice(0, 120);
        // antycheat: strzał szybszy niż człowiek zdąży przeczytać klatkę (mierzy serwer) albo flaga wklejenia od klienta
        if (Date.now() - (r.frameAt || 0) < MIN_HUMAN_MS || m.fast === true) {
          pl.cheats = (pl.cheats || 0) + 1;
          pl.pts -= CHEAT_PENALTY;
          r.triesBy[pl.id] = MAX_TRIES;
          r.cheater = {id: pl.id, at: Date.now()};
          r.feed.push({sys: true, text: '🤡 ' + pl.name + (m.fast === true ? ' wkleił tytuł' : ' strzelił nieludzko szybko') + ' — oszustwo, −' + CHEAT_PENALTY + ' pkt.'});
        } else {
          const f = r.film;
          const ok = (+m.id && +m.id === f.id) || [f.title, f.original_title].some(t => norm(t) && norm(t) === norm(text));
          if (ok) {
            const pts = MAX_TRIES - used;
            pl.pts += pts;
            r.feed.push({ok: true, text: pl.name + ' zgadł za ' + (used + 1) + '. razem! +' + pts + ' pkt'});
            await this.reveal(pl.name);
            await this.broadcast();
            return;
          }
          r.feed.push({bad: true, name: pl.name, text});
          r.triesBy[pl.id] = used + 1;
          if (used + 1 >= MAX_TRIES) r.feed.push({sys: true, text: pl.name + ' wykorzystał wszystkie próby.'});
        }
        // koniec tury, gdy nikt, kto może zgadywać, nie ma już prób
        const canStill = r.players.filter(p => p.online && (r.guesserId ? p.id === r.guesserId : p.id !== r.pickerId) && (r.triesBy[p.id] || 0) < MAX_TRIES);
        if (!canStill.length) await this.reveal(null);
        await this.broadcast();
        break;
      }
      case 'hint':
        if (isHost && r.phase === 'guess' && r.hints.length < r.hintPool.length) { r.hints.push(r.hintPool[r.hints.length]); await this.broadcast() }
        break;
      case 'reveal':
        if (isHost && (r.phase === 'guess' || r.phase === 'time') && r.film) { await this.reveal(null); await this.broadcast() }
        break;
      case 'next':
        if (isHost && r.phase !== 'lobby') { r.round++; this.newTurn(this.nextPicker()); await this.broadcast() }
        break;
      case 'redo':
        if (isHost && r.phase !== 'lobby') { this.newTurn(r.players.find(p => p.id === r.pickerId && p.online) ? r.pickerId : this.nextPicker()); await this.broadcast() }
        break;
      case 'stopnext':
        if (isHost && r.nextAt) { r.nextAt = null; await this.broadcast() }
        break;
    }
  }
}
