/* Ma Journée — organisateur intelligent */
(function () {
  'use strict';

  // ================= Données =================
  var KEY = 'organisateur.v1';
  var DEFAULTS = { home: null, mode: 'transit', dayStart: '08:00', dayEnd: '20:00', buffer: 5, notify: false };
  var state = load();
  var currentDate = dateStr(new Date());
  var viewMode = 'day';
  var editingId = null;
  var pickedPlace = null;
  var packOpen = {};
  var notified = {};
  var map = null, mapLayer = null;
  var installEvent = null;

  function load() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { s = null; }
    if (!s || !Array.isArray(s.items)) s = { items: [] };
    s.settings = Object.assign({}, DEFAULTS, s.settings || {});
    s.favorites = Array.isArray(s.favorites) ? s.favorites : [];
    s.people = Array.isArray(s.people) ? s.people : [];
    s.recentPlaces = Array.isArray(s.recentPlaces) ? s.recentPlaces : [];
    s.items.forEach(function (i) { // migration de l'ancienne version
      if (!i.doneDates) { i.doneDates = {}; if (i.done) i.doneDates[i.date] = true; }
      delete i.done;
      if (!i.repeat) i.repeat = 'none';
      if (!i.priority) i.priority = 'normale';
      if (!i.skip) i.skip = [];
    });
    return s;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* stockage indisponible */ } }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function byId(id) { return state.items.filter(function (i) { return i.id === id; })[0]; }

  // ================= Outils =================
  function $(s) { return document.querySelector(s); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDate(s) { var p = s.split('-'); return new Date(+p[0], p[1] - 1, +p[2]); }
  function addDays(s, n) { var d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
  function today() { return dateStr(new Date()); }
  function nowMin() { var n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
  function toMin(t) { if (!t) return 0; var p = t.split(':'); return (+p[0]) * 60 + (+p[1]); }
  function fmt(m) { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60); }
  function dur(m) { return m >= 60 ? Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + pad(m % 60) : '') : m + ' min'; }
  function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function frDate(s, opts) { return parseDate(s).toLocaleDateString('fr-FR', opts || { weekday: 'long', day: 'numeric', month: 'long' }); }

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  var toastTimer, undoFn = null;
  function toast(msg, onUndo) {
    var t = $('#toast');
    $('#toastText').textContent = msg;
    undoFn = onUndo || null;
    $('#toastUndo').hidden = !undoFn;
    t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; undoFn = null; }, onUndo ? 5000 : 3500);
  }
  $('#toastUndo').addEventListener('click', function () {
    if (undoFn) undoFn();
    undoFn = null; $('#toast').hidden = true;
  });
  // Exécute une modification avec un bouton « Annuler » pendant 5 secondes
  function withUndo(msg, change) {
    var snap = JSON.stringify(state.items);
    change();
    toast(msg, function () { state.items = JSON.parse(snap); save(); render(); toast('Action annulée'); });
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 15); } catch (e) { /* pas de vibration */ } }

  // ================= Répétitions =================
  var REPEAT_LABEL = { daily: 'Tous les jours', weekdays: 'En semaine', weekly: 'Chaque semaine' };
  function occursOn(it, d) {
    if (it.repeat === 'none' || !it.repeat) return it.date === d;
    if (d < it.date || it.skip.indexOf(d) >= 0) return false;
    var dow = parseDate(d).getDay();
    if (it.repeat === 'daily') return true;
    if (it.repeat === 'weekdays') return dow >= 1 && dow <= 5;
    if (it.repeat === 'weekly') return dow === parseDate(it.date).getDay();
    return false;
  }
  function occurrences(d) {
    return state.items.filter(function (i) { return occursOn(i, d); })
      .map(function (i) { return Object.assign({}, i, { done: !!i.doneDates[d], occ: d }); });
  }
  // Déplace une seule occurrence : pour une série, on saute ce jour et on crée une copie ponctuelle
  function moveOccurrence(id, fromDate, patch) {
    var it = byId(id); if (!it) return;
    if (it.repeat === 'none') { Object.assign(it, patch); }
    else {
      it.skip.push(fromDate);
      var copy = Object.assign({}, it, { id: uid(), repeat: 'none', skip: [], doneDates: {}, date: fromDate }, patch);
      state.items.push(copy);
    }
    save(); render();
  }
  function toggleDone(id, d) {
    var it = byId(id); if (!it) return;
    if (it.doneDates[d]) delete it.doneDates[d]; else it.doneDates[d] = true;
    save(); render();
  }
  function removeOccurrence(id, d) {
    var it = byId(id); if (!it) return;
    if (it.repeat === 'none') state.items = state.items.filter(function (i) { return i.id !== id; });
    else it.skip.push(d);
    save(); render();
  }

  // ================= Trajets (estimation) =================
  var SPEED = { walking: 4.5, bicycling: 14, transit: 18, driving: 25 };
  var EXTRA = { walking: 0, bicycling: 2, transit: 6, driving: 6 };
  var MODE_LABEL = { walking: 'à pied', bicycling: 'à vélo', transit: 'en transports', driving: 'en voiture' };

  function km(a, b) {
    var R = 6371, r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function travel(a, b) {
    if (!a || !b) return 0;
    var d = km(a, b) * 1.3;
    if (d < 0.05) return 0;
    var mode = state.settings.mode;
    var m;
    if (mode === 'transit' && d < 1.2) m = d / SPEED.walking * 60;
    else m = d / SPEED[mode] * 60 + EXTRA[mode];
    return Math.max(2, Math.ceil(m / 5) * 5);
  }

  // ================= Planification =================
  function isFixed(i) { return i.fixed && i.start; }
  function placeOf(i) { return i.online ? null : i.place; }

  // Marges intelligentes : arriver un peu en avance selon le type de rendez-vous
  var MARGINS = [
    { re: /\b(train|tgv|gare|aeroport|avion|vol)\b/, m: 20, why: 'gare / aéroport' },
    { re: /\b(medecin|docteur|dentiste|hopital|clinique|radio|irm|prise de sang|laboratoire|kine|ophtalmo|dermato|gyneco|pediatre|veterinaire|generaliste)\b/, m: 10, why: 'accueil et salle d\'attente' },
    { re: /\b(prefecture|mairie|caf|cpam|pole emploi|france travail|impots|banque|notaire|avocat|tribunal|consulat|ambassade)\b/, m: 10, why: 'accueil' },
    { re: /\b(entretien|examen|concours|partiel|oral|soutenance)\b/, m: 15, why: 'ne pas arriver juste' },
    { re: /\b(reunion|rdv client|client|rendez-vous pro)\b/, m: 5, why: 'arriver à l\'heure' },
    { re: /\b(cinema|concert|spectacle|theatre|match)\b/, m: 10, why: 'installation' }
  ];
  function marginInfo(it) {
    if (state.settings.smartMargins === false || it.online || !isFixed(it)) return { m: 0, why: '' };
    var n = norm(it.title);
    var hit = MARGINS.filter(function (x) { return x.re.test(n); })[0];
    return hit ? { m: hit.m, why: hit.why } : { m: 0, why: '' };
  }

  // ================= Horaires d'ouverture (format OpenStreetMap) =================
  // Comprend les formes courantes : « Mo-Fr 09:00-19:00; Sa 09:00-12:00 », « Tu-Sa 12:00-14:00,19:00-22:00 », « Su off », « 24/7 ».
  var OH_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var hoursCache = {};
  function parseHours(s) {
    if (!s) return null;
    s = String(s).trim();
    if (hoursCache[s] !== undefined) return hoursCache[s];
    var res = null;
    if (/^24\/7$/.test(s)) res = { always: true };
    else {
      var week = [null, null, null, null, null, null, null], ok = false;
      s.split(';').forEach(function (rule) {
        rule = rule.trim();
        if (!rule || /^(PH|SH)\b/.test(rule)) return;
        var m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,?\s*)+)?(.*)$/);
        if (!m) return;
        var days = [];
        if (m[1]) {
          m[1].split(',').forEach(function (p) {
            p = p.trim(); if (!p) return;
            var r = p.split('-').map(function (x) { return x.trim(); });
            var a = OH_DAYS.indexOf(r[0]), b = r[1] ? OH_DAYS.indexOf(r[1]) : a;
            if (a < 0 || b < 0) return;
            for (var i = a, guard = 0; guard < 8; i = (i + 1) % 7, guard++) { days.push(i); if (i === b) break; }
          });
        } else days = [0, 1, 2, 3, 4, 5, 6];
        var rest = (m[2] || '').trim(), intervals = [];
        if (!/^(off|closed)$/i.test(rest)) {
          var tm = rest.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/g);
          if (!tm) return;
          tm.forEach(function (t) {
            var q = t.split('-').map(function (x) { return toMin(x.trim()); });
            intervals.push([q[0], q[1] <= q[0] ? q[1] + 1440 : q[1]]);
          });
        }
        days.forEach(function (d) { week[d] = intervals; });
        ok = true;
      });
      res = ok ? { week: week } : null;
    }
    hoursCache[s] = res;
    return res;
  }
  function dayIntervals(place, date) {
    var h = place && parseHours(place.hours);
    if (!h) return null;
    if (h.always) return [[0, 1440]];
    return h.week[parseDate(date).getDay()] || []; // jour non cité = fermé
  }
  function closedAllDay(place, date) { var iv = dayIntervals(place, date); return !!iv && iv.length === 0; }
  // Premier moment où l'on peut faire `dur` minutes sur place à partir de `from` (null = horaires inconnus)
  function openFrom(place, date, from, dur) {
    var iv = dayIntervals(place, date);
    if (!iv) return null;
    for (var i = 0; i < iv.length; i++) {
      var st = Math.max(from, iv[i][0]);
      if (st + dur <= iv[i][1]) return st;
    }
    return -1;
  }
  function openUntil(place, date, at) {
    var iv = dayIntervals(place, date);
    if (!iv) return null;
    for (var i = 0; i < iv.length; i++) if (at >= iv[i][0] && at < iv[i][1]) return iv[i][1] % 1440;
    return -1;
  }

  // opts.naive : sans optimisation (dans l'ordre où les tâches ont été notées), pour mesurer le temps gagné
  function planDay(date, opts) {
    var naive = !!(opts && opts.naive);
    var s = state.settings;
    var items = occurrences(date);
    var fixed = items.filter(isFixed).sort(function (a, b) { return toMin(a.start) - toMin(b.start); });
    var flex = items.filter(function (i) { return !isFixed(i) && !i.done; });
    var doneFlex = items.filter(function (i) { return !isFixed(i) && i.done; });
    var buffer = +s.buffer || 0;
    var isToday = date === today();

    var cur = toMin(s.dayStart);
    if (isToday) cur = Math.max(cur, Math.ceil(nowMin() / 5) * 5);
    if (s.resume && s.resume.date === date) cur = Math.max(cur, s.resume.min); // reprise après un imprévu (SOS)
    var end = toMin(s.dayEnd);
    var pos = s.home;
    var out = [];

    var ongEnd = 0, ongPlace = null; // étape déjà commencée (ex. travail) : on y retourne après un rendez-vous pris pendant ce temps
    fixed.concat([null]).forEach(function (f) {
      var limit = f ? toMin(f.start) - marginInfo(f).m : end;
      var fPlace = f ? placeOf(f) : null;
      var skipFill = false;
      if (ongEnd > cur) {
        if (f && toMin(f.start) < ongEnd) skipFill = true; // pendant le travail : rien à caser avant ce rendez-vous
        else { cur = ongEnd; if (ongPlace) pos = ongPlace; ongEnd = 0; }
      }
      for (;;) {
        if (skipFill) break;
        var best = null;
        flex.forEach(function (t) {
          var tp = placeOf(t);
          var tt = travel(pos, tp);
          var arrive = cur + tt + (tt ? buffer : 0);
          var wait = 0;
          // Une course dont on ne connaît pas encore le lieu : pas avant 9 h (les commerces ouvrent rarement plus tôt)
          if ((!tp || (t.query && !tp.hours)) && !t.online && arrive < 9 * 60) { wait = 9 * 60 - arrive; arrive = 9 * 60; }
          // « pas avant » : après le travail, l'après-midi, le soir, à partir de 14h…
          if (t.after && arrive < toMin(t.after)) { wait += toMin(t.after) - arrive; arrive = toMin(t.after); }
          if (tp && tp.hours) { // attendre l'ouverture si besoin, ou passer si c'est fermé
            var op = openFrom(tp, date, arrive, +t.duration || 15);
            if (op === -1) return;
            if (op !== null && op > arrive) { wait += op - arrive; arrive = op; }
          }
          var finish = arrive + (+t.duration || 15);
          var next = f ? travel(tp || pos, fPlace) : 0;
          if (finish + next + (next ? buffer : 0) > limit) return;
          if (t.deadline && finish > toMin(t.deadline)) return;
          var score = tt + wait;
          if (t.priority === 'haute') score -= 60;
          if (t.deadline) score -= Math.max(0, 180 - (toMin(t.deadline) - cur)) / 2;
          if (!best || (!naive && score < best.score)) best = { t: t, tt: tt, arrive: arrive, finish: finish, score: score };
        });
        if (!best) break;
        out.push({ item: best.t, start: best.arrive, end: best.finish, travel: best.tt });
        cur = best.finish;
        if (placeOf(best.t)) pos = placeOf(best.t);
        flex = flex.filter(function (x) { return x !== best.t; });
      }
      if (f) {
        var st = toMin(f.start), fd = +f.duration || 30;
        if (isToday && st + fd <= cur) { // déjà passé
          out.push({ item: f, start: st, end: st + fd, travel: 0, past: true });
          if (fPlace) pos = fPlace;
          return;
        }
        // Déjà commencé : tu y es (dès le début pour une longue étape comme le travail, après 30 min sinon)
        if (isToday && !f.done && st < nowMin() - (fd >= 120 ? 0 : 30)) {
          out.push({ item: f, start: st, end: st + fd, travel: 0, ongoing: true });
          ongEnd = Math.max(ongEnd, st + fd); ongPlace = fPlace || ongPlace;
          if (fPlace) pos = fPlace;
          return;
        }
        var tt = travel(pos, fPlace);
        var mi = marginInfo(f);
        var arrive = cur + tt + (tt ? buffer : 0);
        var lateBy = f.done ? 0 : arrive + mi.m - st;
        out.push({ item: f, start: st, end: st + fd, travel: tt, late: lateBy > 0, lateBy: Math.max(0, arrive - st), margin: mi.m, marginWhy: mi.why,
          leaveAt: st - tt - (tt ? buffer : 0) - mi.m });
        cur = Math.max(arrive, st) + fd;
        if (fPlace) pos = fPlace;
      }
    });

    var backHome = s.home && pos && pos !== s.home ? travel(pos, s.home) : 0;
    var totalTravel = out.reduce(function (a, o) { return a + o.travel; }, 0) + backHome;
    flex.forEach(function (t) { t.missedDeadline = !!t.deadline; });
    var missing = flex.reduce(function (a, t) { return a + (+t.duration || 15) + (placeOf(t) ? 10 : 0); }, 0);
    var busy = out.reduce(function (a, o) { return a + (o.past ? 0 : o.end - o.start + o.travel); }, 0);
    return { out: out, leftover: flex, doneFlex: doneFlex, totalTravel: totalTravel, finish: cur, backHome: backHome, missing: missing, busy: busy };
  }

  // Rejoue la planification sur une copie modifiée, sans toucher aux vraies données
  function simulate(date, change) {
    var backup = state.items;
    state.items = JSON.parse(JSON.stringify(backup));
    try { change(state.items); return planDay(date); } finally { state.items = backup; }
  }

  // ================= Pense-bête avant de partir =================
  var PACKS = [
    { re: /\b(medecin|docteur|generaliste|pediatre|dermato|ophtalmo|gyneco|kine|specialiste|hopital|clinique|radio|irm)\b/, list: ['Carte Vitale', 'Carte de mutuelle', 'Ordonnance ou courrier'] },
    { re: /\b(dentiste|orthodontiste)\b/, list: ['Carte Vitale', 'Carte de mutuelle'] },
    { re: /\b(prise de sang|laboratoire|analyse)\b/, list: ['Carte Vitale', 'Ordonnance', 'Être à jeun ?'] },
    { re: /\b(pharmacie|medicaments|ordonnance)\b/, list: ['Ordonnance', 'Carte Vitale'] },
    { re: /\b(colis|relais|poste|recommande)\b/, list: ['Avis de passage ou code de retrait', 'Pièce d\'identité'] },
    { re: /\b(banque|notaire)\b/, list: ['Pièce d\'identité', 'RIB', 'Documents demandés'] },
    { re: /\b(prefecture|mairie|caf|cpam|impots|consulat|passeport|carte d'identite)\b/, list: ['Pièce d\'identité', 'Justificatif de domicile', 'Dossier complet', 'Photos d\'identité'] },
    { re: /\b(sport|gym|piscine|muscu|foot|yoga|tennis|course a pied)\b/, list: ['Tenue de sport', 'Gourde', 'Serviette', 'Cadenas'] },
    { re: /\b(travail|boulot|bureau)\b/, list: ['Badge', 'Ordinateur', 'Chargeur'] },
    { re: /\b(ecole|creche|enfants|nounou)\b/, list: ['Cartable', 'Goûter', 'Doudou'] },
    { re: /\b(courses|supermarche|epicerie|marche)\b/, list: ['Sacs'] },
    { re: /\b(train|tgv|gare|avion|aeroport|vol)\b/, list: ['Billet', 'Pièce d\'identité', 'Chargeur'] },
    { re: /\b(entretien|examen|concours|partiel)\b/, list: ['Convocation', 'Pièce d\'identité', 'CV ou dossier', 'Stylo'] },
    { re: /\b(veterinaire)\b/, list: ['Carnet de santé de l\'animal', 'Laisse ou caisse'] },
    { re: /\b(garage|controle technique)\b/, list: ['Carte grise', 'Clés du véhicule'] },
    { re: /\b(reunion|visio|teams|zoom)\b/, list: ['Lien de la réunion', 'Casque'] }
  ];
  function packList(it) {
    if (Array.isArray(it.pack)) return it.pack;
    var n = norm(it.title);
    var hit = PACKS.filter(function (p) { return p.re.test(n); })[0];
    return hit ? hit.list.slice() : [];
  }
  function packChecked(it, d) { return (it.packDone && it.packDone[d]) || {}; }

  // ================= Liens externes =================
  function placeParam(p) { return p.lat + ',' + p.lon; }
  function mapsLink(item) {
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=' + state.settings.mode;
    if (state.settings.home) url += '&origin=' + placeParam(state.settings.home);
    url += '&destination=' + (item.place ? placeParam(item.place) : encodeURIComponent(item.locationText || item.title));
    return url;
  }
  function fullRouteLink(plan) {
    var pts = plan.out.filter(function (o) { return placeOf(o.item) && !o.item.done && !o.past; }).map(function (o) { return o.item.place; });
    if (!pts.length) return null;
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=' + state.settings.mode;
    if (state.settings.home) url += '&origin=' + placeParam(state.settings.home);
    url += '&destination=' + placeParam(pts[pts.length - 1]);
    var way = pts.slice(0, -1).slice(0, 9);
    if (way.length) url += '&waypoints=' + encodeURIComponent(way.map(placeParam).join('|'));
    return url;
  }
  function stamp(d, m) { return d.replace(/-/g, '') + 'T' + pad(Math.floor(m / 60) % 24) + pad(m % 60) + '00'; }
  function placeText(it) { return it.place ? it.place.label : (it.locationText || ''); }
  function googleCalLink(it, d, start, end) {
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(it.title) +
      '&dates=' + stamp(d, start) + '/' + stamp(d, end) + '&location=' + encodeURIComponent(placeText(it)) +
      '&details=' + encodeURIComponent('Ajouté depuis Ma Journée');
  }
  function outlookLink(it, d, start, end) {
    function iso(m) { return d + 'T' + fmt(m) + ':00'; }
    return 'https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=' +
      encodeURIComponent(it.title) + '&startdt=' + encodeURIComponent(iso(start)) + '&enddt=' + encodeURIComponent(iso(end)) +
      '&location=' + encodeURIComponent(placeText(it));
  }

  // ================= Recherche de lieux (OpenStreetMap) =================
  var lastSearch = 0;
  function nominatim(params) {
    var wait = Math.max(0, 1100 - (Date.now() - lastSearch));
    lastSearch = Date.now() + wait;
    return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
      return fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&accept-language=fr&' + params, { headers: { Accept: 'application/json' } });
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (list) {
      return list.map(function (x) {
        var parts = x.display_name.split(', ').filter(function (p) { return !/^(Quartier|France métropolitaine|Île-de-France$)/.test(p); });
        var t = x.extratags || {};
        var place = { name: x.name || parts[0], label: parts.slice(0, 5).join(', '), lat: +x.lat, lon: +x.lon };
        var phone = t.phone || t['contact:phone'], email = t.email || t['contact:email'];
        if (phone) place.phone = String(phone).split(';')[0].trim();
        if (email) place.email = String(email).split(';')[0].trim();
        var web = t.website || t['contact:website'];
        if (web && /^https?:\/\//i.test(web)) place.website = String(web).split(';')[0].trim();
        if (t.cuisine) place.cuisine = String(t.cuisine);
        if (t.opening_hours) place.hours = String(t.opening_hours);
        return place;
      });
    });
  }
  function viewbox(h, dx, dy) { return '&viewbox=' + (h.lon - dx) + ',' + (h.lat + dy) + ',' + (h.lon + dx) + ',' + (h.lat - dy); }
  function geocode(q) {
    var h = state.settings.home;
    return nominatim('limit=6&q=' + encodeURIComponent(q) + (h ? viewbox(h, 0.4, 0.25) : ''));
  }
  // « C'est sur le chemin » : parmi les lieux de ce type, celui qui ajoute le moins de détour
  // au trajet déjà prévu ce jour-là (maison → rendez-vous fixes → maison)
  function routePoints(date) {
    var h = state.settings.home;
    var pts = h ? [h] : [];
    occurrences(date).filter(function (x) { return isFixed(x) && placeOf(x); })
      .sort(function (a, b) { return toMin(a.start) - toMin(b.start); })
      .forEach(function (x) { pts.push(x.place); });
    if (h) pts.push(h);
    return pts;
  }
  function kmMin(k) { return Math.max(1, Math.round(k * 1.3 / SPEED[state.settings.mode] * 60)); }
  function detourKm(pts, c) {
    if (pts.length < 2) return pts.length ? 2 * km(pts[0], c) : 0;
    var best = Infinity;
    for (var i = 0; i < pts.length - 1; i++) {
      var extra = km(pts[i], c) + km(c, pts[i + 1]) - km(pts[i], pts[i + 1]);
      if (extra < best) best = extra;
    }
    return Math.max(0, best);
  }
  function geocodeNearest(q, date) {
    var h = state.settings.home;
    if (!h) return geocode(q).then(function (l) { return l[0] || null; });
    var pts = routePoints(date || currentDate);
    var lats = pts.map(function (p) { return p.lat; }), lons = pts.map(function (p) { return p.lon; });
    var box = '&viewbox=' + (Math.min.apply(null, lons) - 0.02) + ',' + (Math.max.apply(null, lats) + 0.015) + ',' + (Math.max.apply(null, lons) + 0.02) + ',' + (Math.min.apply(null, lats) - 0.015);
    function best(list) {
      if (!list.length) return null;
      // on écarte les lieux fermés toute la journée ce jour-là (horaires OpenStreetMap)
      var open = list.filter(function (c) { return !closedAllDay(c, date || currentDate); });
      if (open.length) list = open;
      list.forEach(function (c) { c._d = detourKm(pts, c); });
      list.sort(function (a, b) { return a._d - b._d; });
      var pick = list[0];
      var closest = list.slice().sort(function (a, b) { return km(h, a) - km(h, b); })[0];
      pick.detour = kmMin(pick._d) <= 2 ? 0 : kmMin(pick._d);
      if (closest !== pick) pick.closestDetour = kmMin(closest._d);
      list.forEach(function (c) { delete c._d; });
      return pick;
    }
    // Les points relais ont des noms variés dans OpenStreetMap : on essaie plusieurs façons de les chercher
    var tries = q === 'point relais' ? ['point relais', 'relais colis', 'mondial relay', 'pickup', 'consigne colis'] : [q];
    var i = 0;
    function next() {
      var qq = tries[i++];
      if (!qq) return nominatim('limit=20&bounded=1&q=' + encodeURIComponent(tries[0]) + viewbox(h, 0.1, 0.07)).then(best);
      return nominatim('limit=40&bounded=1&q=' + encodeURIComponent(qq) + box).then(function (l) { return l.length ? best(l) : next(); });
    }
    return next();
  }
  function onRouteToast(pl) {
    if (!pl) return;
    var t = 'Trouvé : ' + pl.name + (pl.detour ? ' · +' + pl.detour + ' min de détour' : ' · pile sur votre trajet');
    if (pl.closestDetour && pl.closestDetour > (pl.detour || 0) + 2) t += ' (le plus proche de chez vous : +' + pl.closestDetour + ' min)';
    toast(t);
  }

  // ---------- Recherche intelligente : entreprises, adresses et lieux ----------
  // 1. Annuaire officiel des entreprises (recherche-entreprises.api.gouv.fr) : retrouve une société par son nom, avec ses établissements ouverts
  // 2. Base Adresse Nationale (data.geopf.fr) : adresses françaises, suggestions pendant la frappe
  // 3. OpenStreetMap (Nominatim) : commerces, lieux publics… seulement sur « Chercher » (pas de suggestion en direct, règle d'usage)
  function titleCase(s) { return (s || '').toLowerCase().replace(/(^|[\s'’(-])([a-zà-ÿ])/g, function (m, a, b) { return a + b.toUpperCase(); }); }
  function companySearch(q) {
    return fetch('https://recherche-entreprises.api.gouv.fr/search?per_page=5&q=' + encodeURIComponent(q))
      .then(function (r) { return r.ok ? r.json() : { results: [] }; })
      .then(function (j) {
        var out = [];
        (j.results || []).forEach(function (c) {
          var name = c.nom_complet || c.nom_raison_sociale || '';
          var ets = (c.matching_etablissements && c.matching_etablissements.length ? c.matching_etablissements : [c.siege]).filter(function (e) { return e && e.etat_administratif !== 'F' && e.latitude && e.longitude; });
          ets.slice(0, 4).forEach(function (e) {
            out.push({ name: name, label: titleCase(e.adresse || ''), lat: +e.latitude, lon: +e.longitude, kind: e.est_siege ? 'Entreprise · siège' : 'Entreprise · établissement' });
          });
        });
        return out.slice(0, 6);
      }).catch(function () { return []; });
  }
  function addressSearch(q) {
    var h = state.settings.home;
    return fetch('https://data.geopf.fr/geocodage/search?limit=5&autocomplete=1&q=' + encodeURIComponent(q) + (h ? '&lat=' + h.lat + '&lon=' + h.lon : ''))
      .then(function (r) { return r.ok ? r.json() : { features: [] }; })
      .then(function (j) {
        return (j.features || []).filter(function (f) { return (f.properties.score || 0) >= 0.35; }).map(function (f) {
          return { name: f.properties.name || f.properties.label, label: f.properties.label, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], kind: 'Adresse' };
        });
      }).catch(function () { return []; });
  }
  function mergeResults(q, companies, addresses, places) {
    var nq = norm(q), hasDigit = /\d/.test(q);
    var goodCo = companies.filter(function (c) { return norm(c.name).indexOf(nq) >= 0; });
    var otherCo = companies.filter(function (c) { return goodCo.indexOf(c) < 0; });
    var order = hasDigit ? addresses.concat(goodCo, places, otherCo) : goodCo.concat(places, addresses, otherCo);
    var out = [];
    order.forEach(function (p) {
      if (out.some(function (o) { return km(o, p) < 0.03 && norm(o.name) === norm(p.name); })) return;
      out.push(p);
    });
    // Ce qui est près de chez toi d'abord (le « Café de Flore » de Paris avant celui d'Ajaccio)
    var h = state.settings.home;
    if (h) {
      var bucket = function (p) { var d = km(h, p); return d < 40 ? 0 : (d < 150 ? 1 : 2); };
      out = out.map(function (p, i) { return { p: p, i: i, b: bucket(p) }; })
        .sort(function (a, b) { return a.b - b.b || a.i - b.i; }).map(function (x) { return x.p; });
    }
    return out.slice(0, 8);
  }
  function setupSearch(input, btn, results, onPick) {
    var timer = null, seq = 0;
    function hint(t) { return el('p', { class: 'hint', text: t }); }
    function show(list, full) {
      results.innerHTML = '';
      if (!list.length) {
        if (full) results.appendChild(hint('Aucun résultat. Essaie avec la ville, la rue, ou le nom exact de l\'entreprise.'));
        return;
      }
      var h = state.settings.home;
      list.forEach(function (p) {
        var dist = h ? ' · ' + (km(h, p) < 1 ? Math.round(km(h, p) * 1000) + ' m' : km(h, p).toFixed(1).replace('.', ',') + ' km') : '';
        results.appendChild(el('button', { type: 'button', class: 'result', onclick: function () {
          results.innerHTML = ''; clearTimeout(timer); seq++;
          var clean = Object.assign({}, p); delete clean.kind; delete clean._d; delete clean.at;
          rememberPlace(clean);
          onPick(clean);
        } }, el('span', { class: 'rtag', text: p.kind || 'Lieu' }), el('strong', { text: p.name }), el('small', { text: (p.label || '') + dist })));
      });
      if (!full && list.some(function (p) { return p.kind !== 'Récent'; })) results.appendChild(hint('Pas dans la liste ? Appuie sur « Chercher » pour chercher aussi les commerces et lieux publics.'));
    }
    function recents(q) {
      var nq = norm(q || '');
      return state.recentPlaces.filter(function (r) { return !nq || norm(r.name + ' ' + r.label).indexOf(nq) >= 0; })
        .slice(0, nq ? 3 : 5).map(function (r) { return Object.assign({}, r, { kind: nq ? 'Déjà utilisé' : 'Récent' }); });
    }
    function suggest(full) {
      var q = input.value.trim();
      if (q.length < 3) {
        if (full) input.focus();
        var rc = recents(q);
        if (rc.length && !full) show(rc, false); else results.innerHTML = '';
        return;
      }
      var my = ++seq;
      if (full) { results.innerHTML = ''; results.appendChild(hint('Recherche en cours…')); }
      var jobs = [companySearch(q), addressSearch(q)];
      if (full) jobs.push(geocode(q).then(function (l) { return l.map(function (x) { return Object.assign(x, { kind: 'Lieu' }); }); }).catch(function () { return []; }));
      Promise.all(jobs).then(function (r) {
        if (my !== seq) return; // une recherche plus récente a été lancée
        var rc = recents(q);
        var merged = mergeResults(q, r[0], r[1], r[2] || []).filter(function (p) { return !rc.some(function (x) { return km(x, p) < 0.05; }); });
        show(rc.concat(merged).slice(0, 8), full);
      });
    }
    // Lieux récents dès qu'on touche le champ vide
    input.addEventListener('focus', function () { if (!input.value.trim()) { var rc = recents(''); if (rc.length) show(rc, false); } });
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { suggest(false); }, 350); });
    btn.addEventListener('click', function () { clearTimeout(timer); suggest(true); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); suggest(true); } });
  }

  // Une adresse trouvée doit vraiment correspondre : même rue, même code postal (sinon on ne devine pas)
  var ADDR_STOP = ['rue', 'avenue', 'boulevard', 'place', 'chemin', 'allee', 'impasse', 'route', 'quai', 'cours', 'square', 'passage', 'paris', 'france', 'cedex', 'bis', 'ter', 'des', 'les', 'aux', 'sur', 'sous'];
  function addressMatches(q, p) {
    var nq = norm(q), nl = norm((p.label || '') + ' ' + (p.name || ''));
    var cq = (nq.match(/\b\d{5}\b/) || [])[0], cl = (nl.match(/\b\d{5}\b/) || [])[0];
    if (cq && cl && cq !== cl) return false;
    var words = nq.split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 4 && !/^\d+$/.test(w) && ADDR_STOP.indexOf(w) < 0; });
    if (!words.length) return true;
    var hits = words.filter(function (w) { return nl.indexOf(w) >= 0; }).length;
    return hits >= Math.ceil(words.length / 2);
  }
  function findAddress(id, btn) {
    var it = byId(id); if (!it) return Promise.resolve(false);
    if (btn) { btn.disabled = true; btn.textContent = 'Recherche…'; }
    var q = it.locationText;
    var isAddress = /\d/.test(q);
    var keep = function (l) { return isAddress ? l.filter(function (p) { return addressMatches(q, p); }) : l; };
    // une vraie adresse (avec un numéro) → Base Adresse Nationale d'abord ; sinon OpenStreetMap
    var first = isAddress ? addressSearch(q).then(function (l) { l = keep(l); return l.length ? l : geocode(q).then(keep); }) : geocode(q).then(function (l) { return l.length ? l : addressSearch(q); });
    return first.then(function (list) {
      if (list.length) { var p = Object.assign({}, list[0]); delete p.kind; it.place = p; save(); render(); toast('Adresse trouvée : ' + p.name); return true; }
      toast(isAddress ? 'Adresse à vérifier : « ' + q + ' » n\'existe pas telle quelle. Touche « Trouver l\'adresse » ou modifie le lieu.' : 'Adresse introuvable. Modifie le lieu à la main.');
      if (btn) { btn.disabled = false; btn.textContent = "Trouver l'adresse"; }
      return false;
    }).catch(function () {
      toast('Recherche impossible pour le moment.');
      if (btn) { btn.disabled = false; btn.textContent = "Trouver l'adresse"; }
      return false;
    });
  }

  // ================= Ajout rapide (langage courant) =================
  var CATS = [
    { k: ['pharmacie', 'medicaments', 'ordonnance'], q: 'pharmacie', d: 15 },
    { k: ['boulangerie', 'pain', 'baguette'], q: 'boulangerie', d: 10 },
    { k: ['courses', 'supermarche', 'epicerie'], q: 'supermarché', d: 45 },
    { k: ['poste', 'recommande', 'lettre'], q: 'bureau de poste', d: 20 },
    { k: ['colis', 'relais'], q: 'point relais', d: 15 },
    { k: ['banque', 'retrait', 'distributeur'], q: 'banque', d: 15 },
    { k: ['dentiste'], q: 'dentiste', d: 45 },
    { k: ['medecin', 'docteur', 'generaliste'], q: 'médecin', d: 30 },
    { k: ['coiffeur'], q: 'coiffeur', d: 45 },
    { k: ['sport', 'gym', 'piscine', 'muscu'], q: 'salle de sport', d: 60 },
    { k: ['pressing'], q: 'pressing', d: 10 },
    { k: ['mairie'], q: 'mairie', d: 30 },
    { k: ['bibliotheque', 'mediatheque'], q: 'bibliothèque', d: 30 },
    { k: ['laverie'], q: 'laverie', d: 60 }
  ];
  var REMOTE = /\b(appeler|telephoner|mail|email|envoyer|payer|reserver|commander|visio|teams|zoom|rappeler)\b/;
  var DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

  // Prochain jour de la semaine donné, à partir de `from` (inclus, sauf si `strict`)
  function nextDay(from, name, strict) {
    var target = DAYS.indexOf(name.toLowerCase()), x = parseDate(from);
    if (strict) x.setDate(x.getDate() + 1);
    while (x.getDay() !== target) x.setDate(x.getDate() + 1);
    return dateStr(x);
  }

  // ================= Choisir le meilleur jour =================
  // Essaie chaque jour possible et garde celui où la tâche rentre le mieux (charge + trajet)
  // Jours de fermeture habituels (0 = dimanche, 1 = lundi, 6 = samedi)
  var CLOSED = [
    { re: /\b(banque|poste|recommande|pressing|cordonnier)\b/, days: [0] },
    { re: /\b(mairie|prefecture|caf|cpam|impots|notaire|administration)\b/, days: [0, 6] },
    { re: /\b(coiffeur|barbier)\b/, days: [0, 1] }
  ];
  function closedOn(item, d) {
    if (item.place && item.place.hours && !item.online) { var iv = dayIntervals(item.place, d); if (iv) return iv.length === 0; }
    var n = norm(item.title + ' ' + (item.query || ''));
    var dow = parseDate(d).getDay();
    return CLOSED.some(function (c) { return c.re.test(n) && c.days.indexOf(dow) >= 0; });
  }
  function bestDay(item, days, avoid, keep) {
    var avail = Math.max(60, toMin(state.settings.dayEnd) - toMin(state.settings.dayStart));
    var best = null;
    days.forEach(function (d) {
      if (d < today() || (avoid && avoid.indexOf(d) >= 0) || closedOn(item, d)) return;
      var p = simulate(d, function (items) {
        var x = items.filter(function (i) { return i.id === item.id; })[0];
        if (x) x.date = d; else items.push(Object.assign({}, JSON.parse(JSON.stringify(item)), { date: d }));
      });
      if (p.leftover.some(function (t) { return t.id === item.id; })) return;
      var o = p.out.filter(function (x) { return x.item.id === item.id; })[0];
      var score = (p.busy + p.missing) / avail * 100 + (o ? o.travel : 0) + p.leftover.length * 60 + (days.indexOf(d) * 0.5) - (keep === d ? 15 : 0);
      if (!best || score < best.score) best = { d: d, score: score };
    });
    return best ? best.d : null;
  }
  function daysBetween(from, to) {
    var out = [];
    for (var d = from; d <= to && out.length < 31; d = addDays(d, 1)) out.push(d);
    return out;
  }

  function parseQuick(text) {
    // « entre 12h et 14h » ne doit pas être coupé en deux au « et »
    text = text.replace(/(entre\s+\d{1,2}\s*h\s*\d{0,2})\s+et\s+(\d{1,2}\s*h)/gi, '$1 à $2');
    var all = text.split(/[,;\n]+|\s+(?:et|puis)\s+/i).map(function (s) { return s.trim(); }).filter(Boolean).map(function (chunk) {
      var it = { fixed: false, start: '', deadline: '', after: '', duration: 0, priority: 'normale', repeat: 'none', date: currentDate, online: false, place: null, locationText: '', query: '' };
      var t = ' ' + chunk + ' ';
      // Créneaux en langage courant : « entre 14h et 16h », « après 18h », « après le travail », « avant le dentiste »
      var hm2 = function (h, mi) { return pad(+h) + ':' + (mi || '00'); };
      t = t.replace(/\s(?:entre|de)\s+(\d{1,2})\s*h\s*(\d{2})?\s+(?:et|à|a)\s+(\d{1,2})\s*h\s*(\d{2})?(?=\s)/i, function (m, h1, m1, h2, m2) { it.after = hm2(h1, m1); it.deadline = hm2(h2, m2); return ' '; });
      t = t.replace(/\s(?:après|apres|à partir de|a partir de|pas avant)\s+(\d{1,2})\s*h\s*(\d{2})?(?=\s)/i, function (m, h, mi) { it.after = hm2(h, mi); return ' '; });
      t = t.replace(/\s(?:après|apres)\s+(?:le |la |l'|mon |ma |les )?(travail|boulot|taf|bureau|cours|école|ecole|sport|salle|réunion|reunion|rdv|rendez-vous|dentiste|médecin|medecin|déjeuner|dejeuner|[A-ZÉÈ][\wéèêàç-]+)(?=\s)/, function (m, w) { it.afterRef = w; return ' '; });
      t = t.replace(/\s(?:avant)\s+(?:le |la |l'|mon |ma |d'aller (?:au |à la |chez )?)([a-zA-Zéèêàç-]{3,})(?=\s)/i, function (m, w) {
        if (/^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)$/i.test(w)) return m;
        it.beforeRef = w; return ' ';
      });
      // Moments de la journée
      t = t.replace(/\bcet\s+apr[èe]s-?midi\b|\bcet\s+aprem\b/i, function () { it.after = it.after || '13:30'; it.deadline = it.deadline || '18:30'; return " aujourd'hui "; });
      t = t.replace(/\b(?:l'|dans l'|en début d'|en debut d')apr[èe]s-?midi\b|\bl'aprem\b/i, function () { it.after = it.after || '13:30'; it.deadline = it.deadline || '18:30'; return ' '; });
      if (/\b(?:le matin|dans la matin[ée]e|en matin[ée]e|ce matin)\b/i.test(t)) { it.deadline = it.deadline || '12:00'; t = t.replace(/\b(?:le matin|dans la matin[ée]e|en matin[ée]e)\b/i, ' '); }
      if (/\b(?:le soir|ce soir|en soir[ée]e|dans la soir[ée]e)\b/i.test(t)) { it.after = it.after || '18:00'; t = t.replace(/\b(?:le soir|en soir[ée]e|dans la soir[ée]e)\b/i, ' '); }
      t = t.replace(/\bavant\s+(\d{1,2})\s*h\s*(\d{2})?/i, function (m, h, mi) { if (+h < 24) { it.deadline = pad(+h) + ':' + (mi || '00'); return ' '; } return m; });
      t = t.replace(/\s(?:à\s*|a\s+|vers\s+)?(\d{1,2})\s*h\s*(\d{2})?(?=\s)/i, function (m, h, mi) { if (+h < 24) { it.start = pad(+h) + ':' + (mi || '00'); it.fixed = true; return ' '; } return m; });
      // « à midi », « midi et demi », « vers minuit »
      if (!it.start) t = t.replace(/\s(?:à\s+|a\s+|vers\s+|ce\s+)?(midi|minuit)(\s+et\s+demie?|\s+(\d{2}))?(?=\s)/i, function (m, w, half, mi) {
        it.start = (/midi/i.test(w) ? '12' : '00') + ':' + (half && /demi/i.test(half) ? '30' : (mi || '00')); it.fixed = true; return ' ';
      });
      t = t.replace(/(?:pendant\s+)?(\d{1,3})\s*(?:min|minutes?)\b/i, function (m, n) { it.duration = +n; return ' '; });
      t = t.replace(/\burgente?s?\b|\bimportante?\b|!/gi, function () { it.priority = 'haute'; return ' '; });
      t = t.replace(/\b(tous les jours|chaque jour)\b/i, function () { it.repeat = 'daily'; return ' '; });
      t = t.replace(/\b(en semaine|du lundi au vendredi)\b/i, function () { it.repeat = 'weekdays'; return ' '; });
      t = t.replace(/\b(chaque semaine|toutes les semaines)\b/i, function () { it.repeat = 'weekly'; return ' '; });
      t = t.replace(/\b(?:chaque|tous les)\s+(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)s?\b/i, function (m, d) {
        it.repeat = 'weekly';
        var target = DAYS.indexOf(d.toLowerCase()), x = parseDate(currentDate);
        while (x.getDay() !== target) x.setDate(x.getDate() + 1);
        it.date = dateStr(x); return ' ';
      });
      // Jours et semaine : « lundi », « mardi prochain », « cette semaine », « 2 fois cette semaine », « avant vendredi », « ce week-end »
      // En vue Semaine, « jeudi » désigne le jeudi de la semaine affichée
      var base = viewMode === 'week' ? weekStart(currentDate) : currentDate;
      if (base < today()) base = today();
      var wkFrom = weekStart(currentDate) < today() ? today() : weekStart(currentDate);
      var wkTo = addDays(weekStart(currentDate), 6);
      t = t.replace(/\b(\d)\s*fois\s+(?:cette semaine|par semaine|dans la semaine)\b/i, function (m, n) { it.times = Math.min(7, +n); it.window = { from: wkFrom, to: wkTo }; return ' '; });
      t = t.replace(/\b(?:cette semaine|dans la semaine|d'ici dimanche)\b/i, function () { it.window = { from: wkFrom, to: wkTo }; return ' '; });
      t = t.replace(/\b(?:la\s+)?semaine prochaine\b/i, function () { var f = addDays(weekStart(currentDate), 7); it.window = { from: f, to: addDays(f, 6) }; return ' '; });
      t = t.replace(/\bce\s+(?:week-?end|we)\b/i, function () {
        var sat = addDays(weekStart(currentDate), 5); it.window = { from: sat < today() ? today() : sat, to: addDays(sat, 1) }; return ' ';
      });
      t = t.replace(/\bavant\s+(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i, function (m, d) {
        var target = nextDay(base, d, true);
        it.window = { from: base, to: addDays(target, -1) < base ? base : addDays(target, -1) }; return ' ';
      });
      t = t.replace(/\b(apres-demain|après-demain)\b/i, function () { it.date = addDays(base, 2); return ' '; });
      t = t.replace(/\b(demain)\b/i, function () { it.date = addDays(base, 1); return ' '; });
      t = t.replace(/\b(aujourd'hui|ce soir|ce matin)\b/i, function () { it.date = base; return ' '; });
      if (it.repeat === 'none') {
        t = t.replace(/\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(\s+prochain)?\b/i, function (m, d, next) {
          it.date = nextDay(base, d, !!next); return ' ';
        });
      }
      if (it.window) it.date = it.window.from;
      // Un lieu cité : « être à Châtelet », « aller au Louvre », « passer à la gare de Lyon », « rdv chez Darty »
      var locM = t.match(/\s(?:être|etre|aller|passer|me rendre|direction|rendez-vous|rdv|rejoindre|retrouver\s+\S+)\s+(?:à la|a la|à l'|a l'|au|aux|à|a|chez|devant)\s+(.{2,60}?)\s*$/i);
      if (locM) {
        var where = locM[1].trim();
        // « chez Caro » = chez une personne : pas d'adresse à chercher
        if (!/^chez$/i.test((locM[0].match(/\b(chez)\b/i) || [])[1] || '') || !/^[A-ZÉÈ][\wéèêàç-]*$/.test(where)) it.locationText = where;
      }
      t = t.replace(/^\s*(je dois|il faut|faut|penser à|ne pas oublier de)\s+/i, ' ');
      t = t.replace(/\s+(à|a|pour|vers)\s*$/i, ' ').replace(/\s+/g, ' ').trim();
      it.title = cap(t || chunk.trim());

      var n = norm(it.title);
      var fav = state.favorites.filter(function (f) { return n.indexOf(norm(f.name)) >= 0; })[0];
      if (!fav && /\b(boulot|bureau|taf|taff)\b/.test(n)) fav = findFav('Travail');
      if (/\b(travail|boulot|bureau|taf|taff)\b/.test(n) && !it.duration) it.duration = 480;
      if (!fav && /\b(ecole|creche|enfants)\b/.test(n)) fav = findFav('École');
      if (!fav && /\b(salle|muscu|gym|fitness|piscine|club|entrainement)\b/.test(n)) fav = findFav('Sport');
      if (fav && norm(fav.name) === 'sport' && !it.duration) it.duration = 60;
      if (!fav && /\b(maison|domicile|chez moi)\b/.test(n) && state.settings.home) fav = { name: 'Domicile', label: state.settings.home.label, lat: state.settings.home.lat, lon: state.settings.home.lon };
      if (fav) { it.place = { name: fav.name, label: fav.label, lat: fav.lat, lon: fav.lon }; }
      var cat = CATS.filter(function (c) { return c.k.some(function (k) { return new RegExp('\\b' + k).test(n); }); })[0];
      if (REMOTE.test(n) && !cat) { it.online = true; if (!it.duration) it.duration = 15; }
      if (cat) { if (!it.duration) it.duration = cat.d; if (!it.place && !it.fixed) it.query = cat.q; if (it.query || it.place) it.locationText = ''; }
      if (it.place) it.locationText = '';
      // Un proche cité : on reprend son lieu habituel (s'il est connu) et son numéro pour le prévenir
      var who = personIn(chunk.trim());
      if (who) {
        it.person = cap(who);
        var per = findPerson(who);
        if (per && per.place && !it.place && !it.locationText && !it.query && !it.online) it.place = Object.assign({}, per.place);
      }
      // Voir quelqu'un : durées habituelles
      if (!it.duration) {
        if (/\b(dejeuner|dej|dejeune)\b/.test(n) || (it.start === '12:00' && /\b(voir|avec|retrouver)\b/.test(n))) it.duration = 60;
        else if (/\b(diner|soiree|apero)\b/.test(n)) it.duration = 90;
        else if (/\b(cafe|verre)\b/.test(n)) it.duration = 30;
        else if (/\b(voir|retrouver|rencontrer|avec|rdv|rendez-vous|reunion)\b/.test(n)) it.duration = 60;
      }
      if (!it.duration) it.duration = 30;
      return it;
    });
    // « après le travail », « avant le dentiste » : on cherche ce rendez-vous le même jour (déjà prévu ou dans la même phrase)
    all.forEach(function (it) {
      if (!it.afterRef && !it.beforeRef) return;
      var fixedThatDay = occurrences(it.date).filter(isFixed).concat(all.filter(function (x) { return x !== it && x.fixed && x.start && x.date === it.date; }));
      var match = function (ref) {
        var r = norm(ref), isWork = /^(travail|boulot|taf|bureau)$/.test(r);
        return fixedThatDay.filter(function (x) { var nt = norm(x.title); return nt.indexOf(r) >= 0 || (isWork && /travail|boulot|bureau/.test(nt)) || (x.person && norm(x.person) === r); })[0];
      };
      if (it.afterRef) {
        var a = match(it.afterRef);
        if (a) it.after = fmt(toMin(a.start) + (+a.duration || 30));
        else if (/^(travail|boulot|taf|bureau)$/i.test(it.afterRef)) it.after = '18:00';
      }
      if (it.beforeRef) { var b = match(it.beforeRef); if (b) it.deadline = b.start; }
      delete it.afterRef; delete it.beforeRef;
    });
    return all;
  }

  // Prépare les éléments à ajouter à partir d'une phrase, sans rien enregistrer (pour l'aperçu)
  function planAdd(text) {
    var parsed = parseQuick(text);
    var created = [], placedOn = [];
    parsed.forEach(function (p) {
      var copies = p.times || 1, used = [];
      for (var k = 0; k < copies; k++) {
        var item = {
          id: uid(), title: p.title, fixed: p.fixed, date: p.date, start: p.start, deadline: p.fixed ? '' : p.deadline, after: p.fixed ? '' : (p.after || ''),
          duration: p.duration, priority: p.priority, repeat: p.repeat, skip: [], doneDates: {},
          locationText: p.locationText || '', place: p.place, online: p.online, source: 'manuel', query: p.query || '', person: p.person || ''
        };
        if (p.window && !p.fixed) {
          item.window = p.window;
          var days = daysBetween(p.window.from, p.window.to);
          var d = bestDay(item, days, used) || bestDay(item, days) || days.filter(function (x) { return x >= today(); })[0] || p.window.from;
          item.date = d; used.push(d);
          placedOn.push(item.title + ' → ' + frDate(d, { weekday: 'long' }));
        } else if (p.window && p.fixed) item.date = p.window.from;
        state.items.push(item); // provisoire : pour que les suivants tiennent compte de celui-ci
        created.push({ item: item, query: p.query });
      }
    });
    var ids = created.map(function (c) { return c.item.id; });
    state.items = state.items.filter(function (i) { return ids.indexOf(i.id) < 0; });
    return { created: created, placedOn: placedOn };
  }
  // Enregistre les éléments préparés, puis cherche les lieux sur le trajet
  function commitAdd(plan) {
    plan.created.forEach(function (c) { state.items.push(c.item); });
    save(); render();
    // Lieux cités par leur nom (« être à Châtelet ») : on cherche leur adresse
    var named = plan.created.filter(function (c) { return !c.query && c.item.locationText && !c.item.place && !c.item.online; });
    var namedDone = named.reduce(function (p, c) { return p.then(function () { return findAddress(c.item.id); }); }, Promise.resolve());
    var toFind = plan.created.filter(function (c) { return c.query; });
    if (!toFind.length) return namedDone.then(function () { return { found: [], noHome: false }; });
    if (!state.settings.home) {
      toFind.forEach(function (c) { c.item.locationText = c.query; });
      save(); render();
      return namedDone.then(function () { return { found: [], noHome: true }; });
    }
    var found = [];
    // d'abord les lieux précis (ils dessinent le trajet), ensuite les commerces « sur le chemin »
    return toFind.reduce(function (p, c) {
      return p.then(function () {
        return geocodeNearest(c.query, c.item.date).then(function (pl) {
          var it = byId(c.item.id); if (!it) return;
          if (pl) { it.place = pl; found.push(pl); } else it.locationText = c.query;
          save(); render();
        }).catch(function () { var it = byId(c.item.id); if (it) { it.locationText = c.query; save(); } });
      });
    }, namedDone).then(function () { render(); return { found: found, noHome: false }; });
  }

  $('#quickForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = $('#quickInput').value.trim();
    if (!text) { $('#quickInput').focus(); return; }
    var pa = planAdd(text);
    var created = pa.created, placedOn = pa.placedOn;
    $('#quickInput').value = '';
    if (viewMode === 'day' && created.length && !created.some(function (c) { return c.item.date === currentDate; })) currentDate = created[0].item.date;
    var msg = created.length + (created.length > 1 ? ' éléments ajoutés' : ' élément ajouté') + (placedOn.length ? ' (' + placedOn.join(', ') + ')' : '');
    var hasQuery = created.some(function (c) { return c.query; });
    if (hasQuery && state.settings.home) toast(msg + '. Recherche des lieux sur votre trajet…');
    commitAdd(pa).then(function (r) {
      if (!hasQuery) toast(msg + (created.length > 1 ? ', tout est organisé.' : ' et organisé.'));
      else if (r.noHome) toast(msg + '. Indiquez votre point de départ pour trouver les lieux proches.');
      else if (r.found.length === 1) onRouteToast(r.found[0]);
      else toast(r.found.length + ' lieux trouvés sur votre trajet, trajets calculés.');
    });
  });

  // ================= Navigation =================
  var activeView = 'day';
  function syncTabs() {
    var key = activeView === 'day' && viewMode === 'week' ? 'week' : activeView;
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.dataset.goto === key; t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
  }
  function go(view) {
    if (view === 'week') { activeView = 'day'; viewMode = 'week'; view = 'day'; setMode('week'); }
    else if (view === 'day' && activeView === 'day' && viewMode === 'week') { setMode('day'); }
    activeView = view;
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    syncTabs();
    if (view === 'add' && !editingId) resetForm();
    if (view === 'map') renderMap();
    if (view === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-goto]');
    if (g) { e.preventDefault(); if (g.dataset.goto === 'add') editingId = null; go(g.dataset.goto); }
  });

  function setMode(m) {
    viewMode = m;
    $('#modeDay').setAttribute('aria-selected', m === 'day');
    $('#modeWeek').setAttribute('aria-selected', m === 'week');
    syncTabs();
    render();
  }
  $('#modeDay').addEventListener('click', function () { setMode('day'); });
  $('#modeWeek').addEventListener('click', function () { setMode('week'); });
  $('#prevDay').addEventListener('click', function () { currentDate = addDays(currentDate, viewMode === 'week' ? -7 : -1); render(); });
  $('#nextDay').addEventListener('click', function () { currentDate = addDays(currentDate, viewMode === 'week' ? 7 : 1); render(); });
  $('#todayBtn').addEventListener('click', function () { currentDate = today(); render(); });

  function dayLabel(s) {
    var t = today();
    if (s === t) return "Aujourd'hui";
    if (s === addDays(t, 1)) return 'Demain';
    if (s === addDays(t, -1)) return 'Hier';
    return cap(frDate(s));
  }
  function weekStart(s) { var d = parseDate(s); var dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return dateStr(d); }

  // ================= Vue Jour =================
  function render() {
    var week = viewMode === 'week';
    $('#dayPane').hidden = week; $('#weekPane').hidden = !week;
    // L'ajout rapide suit la vue affichée
    var qf = $('#quickForm');
    var slot = week ? $('#weekQuickSlot') : $('#dayPane');
    if (qf.parentNode !== slot) { if (week) slot.appendChild(qf); else slot.insertBefore(qf, slot.firstChild); }
    $('#quickInput').placeholder = week
      ? 'Ex. lundi dentiste à 9h, banque cette semaine, sport 2 fois cette semaine, coiffeur avant vendredi'
      : 'Ex. dentiste à 9h, pharmacie, colis avant 12h, appeler maman 10 min';
    if (week) {
      var ws = weekStart(currentDate);
      $('#dayTitle').textContent = 'Semaine du ' + frDate(ws, { day: 'numeric', month: 'long' });
      $('#todayBtn').hidden = ws === weekStart(today());
      renderWeek(ws);
    } else {
      $('#dayTitle').textContent = dayLabel(currentDate);
      $('#todayBtn').hidden = currentDate === today();
      renderDay();
    }
    if ($('#view-map').classList.contains('active')) renderMap();
  }

  function itemCard(o) {
    var it = o.item, d = it.occ;
    var fixed = isFixed(it);
    var where = it.online ? 'Sans déplacement' : (it.place ? (norm(it.place.name) === 'sport' ? 'Salle de sport' : it.place.name) : (it.locationText || 'Lieu à préciser'));
    var meta = where + ' · ' + dur(+it.duration || 30) + (it.after && !fixed ? ' · pas avant ' + it.after : '') + (it.deadline && !fixed ? ' · avant ' + it.deadline : '') +
      (it.source && it.source !== 'manuel' && it.source !== 'exemple' ? ' · via ' + it.source : '');
    var detourNote = it.place && it.place.detour != null && !it.done
      ? el('p', { class: 'onroute', text: it.place.detour <= 2 ? 'Pile sur votre trajet' : 'Sur votre trajet · +' + it.place.detour + ' min de détour' }) : null;
    // Horaires d'ouverture connus : ouvert jusqu'à quand, ou alerte si fermé
    // Météo au moment de partir
    var wxNote = null;
    if (o.travel && !o.past && !it.done && !it.online) {
      var wl = wxAt(d, o.leaveAt || (o.start - o.travel));
      if (isWet(wl)) wxNote = el('p', { class: 'wxnote', text: wxLabel(wl.c) + ' au départ (' + wl.p + ' %) : prends un parapluie' + (state.settings.mode === 'bicycling' ? ', ou les transports plutôt que le vélo' : '') });
    }
    var hoursNote = null;
    if (placeOf(it) && it.place.hours && !it.done && !o.past) {
      var until = openUntil(it.place, d, o.start);
      if (until === -1) hoursNote = el('p', { class: 'hours closed', text: 'Sans doute fermé à cette heure (horaires OpenStreetMap)' });
      else if (until !== null) hoursNote = el('p', { class: 'hours' + (until < o.end ? ' closed' : ''), text: until < o.end ? 'Ferme à ' + fmt(until) + ' : ce sera juste' : 'Ouvert jusqu\'à ' + fmt(until) });
    }

    var badges = el('div', { class: 'badges' },
      it.priority === 'haute' ? el('span', { class: 'badge hot', text: 'Urgent' }) : null,
      it.repeat !== 'none' ? el('span', { class: 'badge rep', text: REPEAT_LABEL[it.repeat] }) : null,
      el('span', { class: 'badge ' + (fixed ? 'fixed' : 'flex'), text: fixed ? 'Fixe' : 'Flexible' }));

    var btns = el('div', { class: 'btns' });
    if (!it.online && (it.place || it.locationText) && !it.done) {
      btns.appendChild(el('a', { class: 'btn primary', href: mapsLink(it), target: '_blank', rel: 'noopener' }, 'Y aller'));
    }
    if (!it.place && it.locationText && !it.online) {
      btns.appendChild(el('button', { class: 'btn', type: 'button', onclick: function (e) { findAddress(it.id, e.currentTarget); } }, "Trouver l'adresse"));
    }
    if (!it.place && !it.locationText && !it.online && !it.done) {
      btns.appendChild(el('button', { class: 'btn', type: 'button', onclick: function () { startEdit(it.id); } }, 'Préciser le lieu'));
    }
    btns.appendChild(el('button', { class: 'btn', type: 'button', onclick: function () { markDone(it.id, d); } }, it.done ? 'Annuler' : 'Terminé'));
    btns.appendChild(el('button', { class: 'btn warn', type: 'button', 'aria-haspopup': 'dialog', onclick: function () { openSheet(it.id, d, 'move'); } }, 'Actions'));

    var card = el('article', { class: 'card' + (it.done ? ' done' : '') + (it.priority === 'haute' && !it.done ? ' hot' : '') },
      el('div', { class: 'head' }, el('h3', { class: 'title', text: it.title }), badges),
      el('p', { class: 'meta', text: meta }),
      detourNote,
      hoursNote,
      wxNote,
      it.notes ? el('p', { class: 'item-notes', text: it.notes }) : null,
      it.done ? null : packBox(it, d),
      btns);
    var swipe = el('div', { class: 'swipe' },
      el('div', { class: 'swipe-bg', 'aria-hidden': 'true' },
        el('span', { class: 'sw-done', text: it.done ? '↺ Pas fait' : '✓ Terminé' }),
        el('span', { class: 'sw-act', text: 'Reprogrammer · Annuler · Prévenir' })),
      card);
    makeSwipe(swipe, card, function () { markDone(it.id, d); }, function () { openSheet(it.id, d, 'move'); });

    var travelText = null;
    if (o.ongoing) travelText = el('p', { class: 'travel', text: 'En cours, jusqu\'à ' + fmt(o.end) });
    if (o.travel && !o.past) {
      travelText = el('p', { class: 'travel' + (o.late ? ' late' : '') },
        (o.late ? (o.lateBy ? 'Retard prévu : ' + o.lateBy + ' min · ' : 'Ce sera juste · ') : '') + '≈ ' + dur(o.travel) + ' ' + MODE_LABEL[state.settings.mode] +
        (fixed && o.leaveAt ? ' · partir à ' + fmt(o.leaveAt) : '') +
        (o.margin ? ' (' + o.margin + ' min d\'avance : ' + o.marginWhy + ')' : ''));
    }
    return el('div', { class: 'row' },
      el('div', { class: 'time' }, fmt(o.start), el('small', { text: fmt(o.end) })),
      el('div', { class: 'col' }, travelText, swipe));
  }

  // Liste « À prendre » repliable sur chaque carte
  function packBox(it, d) {
    var list = packList(it);
    var src = byId(it.id);
    if (!src) return null;
    var checked = packChecked(src, d);
    var nOk = list.filter(function (x) { return checked[x]; }).length;
    var isShop = /\b(courses|supermarche|epicerie|marche|drive)\b/.test(norm(it.title));
    var box = el('details', { class: 'pack' + (list.length && nOk === list.length ? ' ok' : '') },
      el('summary', null, isShop ? (list.length ? 'Liste de courses · ' + nOk + '/' + list.length : '+ Liste de courses') : (list.length ? 'À prendre · ' + nOk + '/' + list.length : '+ Liste « à prendre »')));
    if (packOpen[it.id + d]) box.open = true;
    box.addEventListener('toggle', function () { packOpen[it.id + d] = box.open; });
    var ul = el('ul', null);
    list.forEach(function (label) {
      var cb = el('input', { type: 'checkbox' });
      cb.checked = !!checked[label];
      cb.addEventListener('change', function () {
        src.packDone = src.packDone || {};
        src.packDone[d] = src.packDone[d] || {};
        if (cb.checked) src.packDone[d][label] = true; else delete src.packDone[d][label];
        if (cb.checked) buzz(8);
        save(); render();
      });
      ul.appendChild(el('li', null, el('label', null, cb, ' ' + label),
        el('button', { type: 'button', class: 'x', 'aria-label': 'Retirer ' + label, onclick: function () {
          src.pack = packList(src).filter(function (x) { return x !== label; }); save(); render();
        } }, '×')));
    });
    box.appendChild(ul);
    var add = el('input', { type: 'text', placeholder: isShop ? 'Ajouter (ex. lait, pain, œufs)' : 'Ajouter (ex. clés, parapluie)', 'aria-label': isShop ? 'Ajouter à la liste de courses' : 'Ajouter un objet à prendre' });
    var form = el('form', { class: 'packadd', onsubmit: function (e) {
      e.preventDefault();
      var v = add.value.trim(); if (!v) return;
      src.pack = packList(src).concat([v]); save(); render();
    } }, add, el('button', { type: 'submit', class: 'btn' }, 'Ajouter'));
    box.appendChild(form);
    return box;
  }

  function markDone(id, d) {
    var it = byId(id); if (!it) return;
    var was = !!it.doneDates[d];
    buzz(was ? 10 : 25);
    withUndo(was ? 'Remis à faire' : '« ' + it.title + ' » terminé', function () {
      if (was) delete it.doneDates[d]; else it.doneDates[d] = true;
      save(); render();
    });
  }

  // ================= Glisser (droite = terminé, gauche = actions) =================
  function makeSwipe(wrap, card, onRight, onLeft) {
    var x0 = null, y0 = 0, dx = 0, dragging = false, pid = null, LIMIT = 90;
    card.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || e.target.closest('a,button,input,select,textarea,summary,label,form,details[open]')) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0; dragging = false; pid = e.pointerId;
    });
    card.addEventListener('pointermove', function (e) {
      if (x0 === null || e.pointerId !== pid) return;
      var mx = e.clientX - x0, my = e.clientY - y0;
      if (!dragging) {
        if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.4) {
          dragging = true; try { card.setPointerCapture(pid); } catch (err) { /* ignore */ }
          wrap.classList.add('dragging');
        } else if (Math.abs(my) > 12) { x0 = null; return; } else return;
      }
      dx = Math.max(-160, Math.min(160, mx));
      card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 80) + 'deg)';
      wrap.dataset.dir = dx > 0 ? 'right' : 'left';
      var armed = Math.abs(dx) > LIMIT;
      if (armed && !wrap.classList.contains('armed')) buzz(8);
      wrap.classList.toggle('armed', armed);
    });
    function end() {
      if (x0 === null) return;
      x0 = null;
      if (!dragging) return;
      dragging = false;
      var dist = dx; dx = 0;
      wrap.classList.remove('dragging', 'armed');
      card.style.transition = 'transform .22s ease-out';
      card.style.transform = '';
      setTimeout(function () { card.style.transition = ''; }, 230);
      if (dist > LIMIT) onRight(); else if (dist < -LIMIT) onLeft();
    }
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  // ================= Détecteur de journées impossibles =================
  // Déplace une occurrence dans une copie des données (pour simuler)
  function moveInItems(items, id, from, to) {
    var it = items.filter(function (x) { return x.id === id; })[0]; if (!it) return;
    if (it.repeat === 'none') it.date = to;
    else { it.skip.push(from); items.push(Object.assign({}, it, { id: id + '-sim', repeat: 'none', skip: [], doneDates: {}, date: to })); }
  }
  function buildFixes(d, plan) {
    var fixes = [];
    var n0 = plan.leftover.length;
    var placed = plan.out.filter(function (o) { return !isFixed(o.item) && !o.item.done && !o.past; }).map(function (o) { return o.item; });
    // 1. Raccourcir une tâche longue
    placed.concat(plan.leftover).filter(function (t) { return (+t.duration || 0) >= 40 && t.priority !== 'haute'; }).forEach(function (t) {
      var nd = Math.max(15, Math.round(t.duration * 0.6 / 5) * 5);
      var p = simulate(d, function (items) { items.forEach(function (x) { if (x.id === t.id) x.duration = nd; }); });
      if (p.leftover.length < n0) fixes.push({ score: n0 - p.leftover.length, plan: p, label: 'Raccourcir « ' + t.title + ' » à ' + dur(nd),
        apply: function () { moveOccurrence(t.id, d, { duration: nd }); } });
    });
    // 2. Reporter une tâche secondaire pour faire passer une tâche urgente ou avec heure limite
    var important = plan.leftover.filter(function (t) { return t.priority === 'haute' || t.deadline; });
    if (important.length) placed.filter(function (t) { return t.priority !== 'haute' && !t.deadline; }).forEach(function (t) {
      var p = simulate(d, function (items) { moveInItems(items, t.id, d, addDays(d, 1)); });
      var ok = important.filter(function (i) { return !p.leftover.some(function (x) { return x.id === i.id; }); });
      if (ok.length) fixes.push({ score: ok.length + 0.5, plan: p, label: 'Reporter « ' + t.title + ' » à demain pour faire « ' + ok[0].title + ' » aujourd\'hui',
        apply: function () { moveOccurrence(t.id, d, { date: addDays(d, 1) }); } });
    });
    // 3. Reporter ce qui ne rentre pas au prochain jour qui a de la place
    for (var k = 1; k <= 7; k++) {
      var day = addDays(d, k);
      var ids = plan.leftover.map(function (t) { return t.id; });
      var pDay = simulate(day, function (items) { ids.forEach(function (id) { moveInItems(items, id, d, day); }); });
      var fits = !pDay.leftover.some(function (x) { return ids.indexOf(x.id.replace('-sim', '')) >= 0; });
      if (fits) {
        var what = n0 > 1 ? 'les ' + n0 + ' tâches en trop' : '« ' + plan.leftover[0].title + ' »';
        var target = day;
        fixes.push({ score: 0.2, plan: null, label: 'Reporter ' + what + ' à ' + (k === 1 ? 'demain' : frDate(day, { weekday: 'long', day: 'numeric' })),
          apply: function () { plan.leftover.forEach(function (t) { moveOccurrence(t.id, d, { date: target }); }); } });
        break;
      }
    }
    fixes.sort(function (a, b) { return b.score - a.score; });
    return fixes.slice(0, 3);
  }
  function renderOverload(plan) {
    var box = $('#overload'); box.innerHTML = '';
    box.hidden = !plan.leftover.length;
    if (!plan.leftover.length) return;
    var d = currentDate;
    box.appendChild(el('div', { class: 'ov-head' },
      el('span', { class: 'ov-badge', text: 'Trop chargée' }),
      el('h2', { text: 'Il manque environ ' + dur(Math.ceil(plan.missing / 5) * 5) + ' pour tout faire' })));
    box.appendChild(el('p', { class: 'hint', text: 'Ne rentre pas : ' + plan.leftover.map(function (t) { return t.title; }).join(', ') + '. Choisissez un compromis :' }));
    buildFixes(d, plan).forEach(function (f) {
      var result = !f.plan ? 'Tout trouve sa place' : (f.plan.leftover.length ? 'Il manquera encore ' + dur(Math.ceil(f.plan.missing / 5) * 5) : 'Journée faisable');
      box.appendChild(el('button', { type: 'button', class: 'fix', onclick: function () {
        withUndo('Compromis appliqué', function () { f.apply(); save(); render(); });
        buzz(20);
      } }, el('span', { text: f.label }), el('small', { class: f.plan && f.plan.leftover.length ? '' : 'good', text: result })));
    });
  }

  function renderNextUp(plan) {
    var box = $('#nextUp'); box.innerHTML = ''; box.hidden = true;
    if (currentDate !== today()) return;
    var n = nowMin();
    var next = plan.out.filter(function (o) { return !o.item.done && !o.past && !o.ongoing && o.end > n; })[0];
    if (!next) {
      var cur = plan.out.filter(function (o) { return o.ongoing && !o.item.done; })[0];
      if (cur) { box.hidden = false; box.appendChild(el('div', null, el('small', { text: 'En cours' }), el('strong', { text: cur.item.title }), el('span', { text: 'Jusqu\'à ' + fmt(cur.end) + ', ensuite rien de prévu' }))); }
      return;
    }
    if (!next) return;
    var leave = next.travel ? (next.leaveAt || next.start - next.travel) : next.start;
    // Compte à rebours : « Pars dans 12 min »
    var left = leave - n;
    var when;
    if (left <= 0) when = next.travel ? 'Pars maintenant !' : 'C\'est maintenant';
    else if (left <= 180) when = (next.travel ? 'Pars dans ' : 'Dans ') + dur(left) + (next.travel ? ' (à ' + fmt(leave) + ')' : '');
    else when = next.travel ? 'Départ à ' + fmt(leave) : 'À ' + fmt(next.start);
    var late = lateMinutes(next.item, currentDate);
    if (late) when = 'Retard estimé : ' + late + ' min';
    box.classList.toggle('soon', !late && left <= 10);
    box.classList.toggle('lateb', !!late);
    box.hidden = false;
    box.appendChild(el('div', null,
      el('small', { text: 'Prochaine étape' }),
      el('strong', { text: fmt(next.start) + ' · ' + next.item.title }),
      el('span', { class: 'countdown', text: when + (next.travel ? ' · ≈ ' + dur(next.travel) + ' de trajet' : '') })));
    var src = byId(next.item.id);
    var toTake = src ? packList(src).filter(function (x) { return !packChecked(src, currentDate)[x]; }) : [];
    if (next.travel && isWet(wxAt(currentDate, leave))) toTake.push('Parapluie');
    if (toTake.length) box.firstChild.appendChild(el('span', { class: 'take', text: 'À prendre : ' + toTake.join(', ') }));
    if (next.item.notes) box.firstChild.appendChild(el('span', { class: 'take', text: 'Note : ' + next.item.notes }));
    var acts = el('div', { class: 'acts' });
    if (placeOf(next.item) || (next.item.locationText && !next.item.online)) acts.appendChild(el('a', { href: mapsLink(next.item), target: '_blank', rel: 'noopener' }, 'Y aller'));
    if (late && isFixed(next.item)) acts.appendChild(el('button', { type: 'button', class: 'late-btn', onclick: function () { openSheet(next.item.id, currentDate, 'notify', 'late'); } }, 'Je suis en retard'));
    if (acts.children.length) box.appendChild(acts);
  }

  function renderDay() {
    $('#homeWarning').hidden = !!state.settings.home;
    var plan = planDay(currentDate);
    var count = occurrences(currentDate).length;
    renderBrief(plan);
    renderNextUp(plan);
    renderOverload(plan);
    $('#sosBtn').hidden = !(currentDate === today() && plan.out.some(function (o) { return !o.past && !o.item.done; }));

    var stats = $('#stats'); stats.innerHTML = '';
    if (count) {
      [['Trajets', plan.totalTravel ? '≈ ' + dur(plan.totalTravel) : '—'],
       ['Fin prévue', plan.out.length ? fmt(plan.finish) : '—'],
       ['Étapes', String(plan.out.length)]].forEach(function (s) {
        stats.appendChild(el('div', { class: 'stat' }, el('span', { text: s[0] }), el('strong', { text: s[1] })));
      });
    }

    var tl = $('#timeline'); tl.innerHTML = '';
    if (!plan.out.length) {
      if (count) tl.appendChild(el('div', { class: 'empty' }, 'Tout est fait pour ce jour. Bravo !'));
      else if (!state.items.length) {
        tl.appendChild(el('div', { class: 'empty' },
          el('span', { text: "Rien de prévu. Écrivez vos tâches dans l'ajout rapide, l'app trouve les lieux, l'ordre et les trajets." }),
          el('button', { class: 'btn', type: 'button', onclick: loadDemo }, 'Voir un exemple')));
      } else tl.appendChild(el('div', { class: 'empty' }, 'Rien de prévu ce jour-là.'));
    }
    if (plan.out.length && !state.settings.swipeTip) {
      tl.appendChild(el('div', { class: 'tip' },
        el('p', { text: 'Astuce : glissez une étape vers la droite pour la terminer, vers la gauche pour la reprogrammer, l\'annuler ou prévenir.' }),
        el('button', { type: 'button', onclick: function () { state.settings.swipeTip = true; save(); render(); } }, 'Compris')));
    }
    feedbackNudge(tl);
    plan.out.forEach(function (o) { tl.appendChild(itemCard(o)); });
    if (plan.backHome && plan.out.length) tl.appendChild(el('p', { class: 'travel', text: 'Retour au point de départ ≈ ' + dur(plan.backHome) }));

    var lb = $('#leftover'); lb.innerHTML = '';
    $('#leftoverBox').hidden = !plan.leftover.length;
    plan.leftover.forEach(function (it) {
      lb.appendChild(el('div', { class: 'card' },
        el('div', { class: 'head' }, el('h3', { class: 'title', text: it.title }), el('span', { class: 'badge flex', text: dur(+it.duration || 15) })),
        it.missedDeadline ? el('p', { class: 'meta', text: 'Impossible avant ' + it.deadline + ' avec le reste du planning.' }) : null,
        placeOf(it) && closedAllDay(it.place, it.occ) ? el('p', { class: 'hours closed', text: it.place.name + ' est fermé ce jour-là (horaires OpenStreetMap)' }) :
          (placeOf(it) && it.place.hours ? el('p', { class: 'hours', text: 'Horaires : ' + it.place.hours }) : null),
        el('div', { class: 'btns' },
          el('button', { class: 'btn', type: 'button', onclick: function () { moveOccurrence(it.id, it.occ, { date: addDays(it.occ, 1) }); } }, 'Mettre demain'),
          el('button', { class: 'btn', type: 'button', onclick: function () { startEdit(it.id); } }, 'Modifier'))));
    });

    var dl = $('#doneList'); dl.innerHTML = '';
    $('#doneBox').hidden = !plan.doneFlex.length;
    plan.doneFlex.forEach(function (it) {
      dl.appendChild(el('div', { class: 'card done' },
        el('div', { class: 'head' }, el('h3', { class: 'title', text: it.title })),
        el('div', { class: 'btns' },
          el('button', { class: 'btn', type: 'button', onclick: function () { toggleDone(it.id, it.occ); } }, 'Annuler'),
          el('button', { class: 'btn danger', type: 'button', onclick: function () { removeOccurrence(it.id, it.occ); } }, 'Supprimer'))));
    });

    var link = fullRouteLink(plan);
    ['#fullRoute', '#fullRoute2'].forEach(function (s) { var a = $(s); a.hidden = !link; if (link) a.href = link; });
    $('#shareBtn').disabled = $('#exportBtn').disabled = !plan.out.length;
  }

  // ================= Retard, créneaux libres, messages =================
  function hFr(t) { var p = t.split(':'); return (+p[0]) + ' h' + (p[1] !== '00' ? ' ' + p[1] : ''); }
  function whenFr(d, start) { return frDate(d, { weekday: 'long', day: 'numeric', month: 'long' }) + (start ? ' à ' + hFr(start) : ''); }
  function lateMinutes(it, d) {
    if (d !== today() || !isFixed(it) || it.done) return 0;
    var o = planDay(d).out.filter(function (x) { return x.item.id === it.id; })[0];
    var n = nowMin(), st = toMin(it.start);
    if (!o || o.ongoing || n >= st + (+it.duration || 30)) return 0;
    var late = Math.max(n + (o.travel || 0) - st, o.lateBy || 0);
    return late > 0 ? Math.ceil(late / 5) * 5 : 0;
  }
  // 3 créneaux libres sur les 2 prochaines semaines, à la même heure si possible
  function freeSlots(it, fromDate) {
    var s = state.settings, durM = +it.duration || 30, out = [];
    var startD = fromDate < today() ? today() : fromDate;
    for (var i = 1; i <= 21 && out.length < 3; i++) {
      var d = addDays(startD, i);
      var busy = occurrences(d).filter(function (x) { return isFixed(x) && x.id !== it.id; })
        .map(function (x) { return [toMin(x.start) - 15, toMin(x.start) + (+x.duration || 30) + 15]; });
      var cands = [];
      if (it.start) cands.push(toMin(it.start));
      for (var m = toMin(s.dayStart); m + durM <= toMin(s.dayEnd); m += 30) cands.push(m);
      for (var k = 0; k < cands.length; k++) {
        var c = cands[k];
        var free = c >= toMin(s.dayStart) && c + durM <= toMin(s.dayEnd) && busy.every(function (b) { return c + durM <= b[0] || c >= b[1]; });
        if (free) { out.push({ date: d, start: fmt(c) }); break; }
      }
    }
    return out;
  }
  function slotFr(sl) { return frDate(sl.date, { weekday: 'long', day: 'numeric' }) + ' à ' + hFr(sl.start); }
  var TEMPLATES = [
    { id: 'late', label: 'En retard' },
    { id: 'cancel', label: 'Annuler' },
    { id: 'resched', label: 'Déplacer' },
    { id: 'confirm', label: 'Confirmer' },
    { id: 'arrive', label: 'J\'arrive' }
  ];
  function messageFor(tpl, it, d) {
    var when = whenFr(d, it.start);
    var sign = state.settings.name ? '\n' + state.settings.name : '';
    var txt;
    if (tpl === 'late') {
      var late = lateMinutes(it, d) || 10;
      txt = 'Bonjour, je suis en route mais j\'aurai environ ' + late + ' minutes de retard pour mon rendez-vous' + (it.start ? ' de ' + hFr(it.start) : '') + '. Désolé pour la gêne.';
    } else if (tpl === 'cancel') {
      txt = 'Bonjour, je dois malheureusement annuler mon rendez-vous du ' + when + '. Merci de votre compréhension.';
    } else if (tpl === 'resched') {
      var sl = freeSlots(it, d).map(slotFr);
      txt = 'Bonjour, serait-il possible de déplacer mon rendez-vous du ' + when + ' ?' + (sl.length ? ' Je suis disponible ' + sl.join(', ou ') + '.' : '') + ' Merci beaucoup.';
    } else if (tpl === 'moved') {
      txt = 'Bonjour, serait-il possible de déplacer mon rendez-vous du ' + whenFr(sheet.fromDate, sheet.fromStart) + ' au ' + when + ' ? Merci beaucoup.';
    } else if (tpl === 'confirm') {
      txt = 'Bonjour, je vous confirme ma présence à mon rendez-vous du ' + when + '. À bientôt.';
    } else {
      txt = 'Bonjour, je suis tout près, j\'arrive dans quelques minutes.';
    }
    return txt + sign;
  }
  function intlPhone(p) {
    var x = (p || '').replace(/[^\d+]/g, '');
    if (/^0\d{9}$/.test(x)) x = '33' + x.slice(1);
    return x.replace(/^\+/, '').replace(/^00/, '');
  }
  function contactOf(it) {
    // un proche passe avant le lieu : pour « voir Caro au café », on prévient Caro, pas le café
    var per = it.person ? findPerson(it.person) : null;
    return {
      phone: it.phone || (per && per.phone) || (it.place && it.place.phone) || '',
      email: it.email || (per && per.email) || (it.place && it.place.email) || ''
    };
  }

  // ================= Feuille d'actions =================
  var sheet = { id: null, d: null, tab: 'move', tpl: null, item: null, fromDate: null, fromStart: null };
  var SHEET_TABS = [['move', 'Reprogrammer'], ['notify', 'Prévenir'], ['cancel', 'Annuler'], ['more', 'Plus']];

  function openSheet(id, d, tab, tpl) {
    var it = byId(id); if (!it) return;
    sheet = { id: id, d: d, tab: tab || 'move', tpl: tpl || null, item: JSON.parse(JSON.stringify(it)), fromDate: d, fromStart: it.start };
    renderSheet();
    var dl = $('#sheet');
    if (!dl.open) { if (dl.showModal) dl.showModal(); else dl.setAttribute('open', ''); }
    buzz(12);
  }
  function closeSheet() { var dl = $('#sheet'); if (dl.open) dl.close(); }
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', function (e) { if (e.target === this) closeSheet(); });
  function setSheetTab(t, tpl) { sheet.tab = t; if (tpl) sheet.tpl = tpl; renderSheet(); }

  function renderSheet() {
    var it = byId(sheet.id) || sheet.item;
    var d = sheet.d;
    $('#sheetTitle').textContent = it.title;
    $('#sheetWhen').textContent = cap(frDate(d, { weekday: 'long', day: 'numeric', month: 'long' })) + (isFixed(it) ? ' · ' + it.start : '');
    var tabs = $('#sheetTabs'); tabs.innerHTML = '';
    SHEET_TABS.forEach(function (t) {
      tabs.appendChild(el('button', { type: 'button', role: 'tab', 'aria-selected': sheet.tab === t[0] ? 'true' : 'false', onclick: function () { setSheetTab(t[0]); } }, t[1]));
    });
    var body = $('#sheetBody'); body.innerHTML = '';
    ({ move: sheetMove, notify: sheetNotify, cancel: sheetCancel, more: sheetMore })[sheet.tab](body, it, d);
  }

  function sheetMove(body, it, d) {
    var fixed = isFixed(it);
    if (fixed) {
      var slots = freeSlots(it, d);
      body.appendChild(el('p', { class: 'sectlabel', text: 'Créneaux libres dans votre agenda' }));
      if (!slots.length) body.appendChild(el('p', { class: 'hint', text: 'Aucun créneau libre trouvé sur les 3 prochaines semaines.' }));
      var grid = el('div', { class: 'slots' });
      slots.forEach(function (sl) {
        var dt = parseDate(sl.date);
        grid.appendChild(el('button', { type: 'button', class: 'slot', onclick: function () { doMove(it, d, sl.date, sl.start); } },
          el('small', { text: cap(dt.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })) }),
          el('strong', { text: sl.start })));
      });
      body.appendChild(grid);
    } else {
      body.appendChild(el('p', { class: 'sectlabel', text: 'Déplacer cette tâche' }));
      var quick = el('div', { class: 'slots' });
      [['Demain', 1], ['Après-demain', 2], ['Dans 1 semaine', 7]].forEach(function (q) {
        var nd = addDays(d, q[1]);
        quick.appendChild(el('button', { type: 'button', class: 'slot', onclick: function () { doMove(it, d, nd, ''); } },
          el('small', { text: cap(parseDate(nd).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })) }),
          el('strong', { text: q[0] })));
      });
      body.appendChild(quick);
    }
    body.appendChild(el('p', { class: 'sectlabel', text: 'Ou choisir moi-même' }));
    var nd2 = el('input', { type: 'date', id: 'mvDate', value: addDays(d, 1), 'aria-label': 'Nouvelle date' });
    var nt2 = fixed ? el('input', { type: 'time', id: 'mvTime', value: it.start, 'aria-label': 'Nouvelle heure' }) : null;
    body.appendChild(el('div', { class: 'grid2' }, el('div', null, nd2), nt2 ? el('div', null, nt2) : null));
    body.appendChild(el('button', { type: 'button', class: 'btn primary block', onclick: function () {
      if (!nd2.value || (nt2 && !nt2.value)) return;
      doMove(it, d, nd2.value, nt2 ? nt2.value : '');
    } }, 'Déplacer'));
    var q = it.query || (CATS.filter(function (c) { return c.k.some(function (k) { return new RegExp('\\b' + k).test(norm(it.title)); }); })[0] || {}).q;
    if (!fixed && q && state.settings.home && byId(it.id)) {
      body.appendChild(el('p', { class: 'sectlabel', text: 'Changer de lieu' }));
      body.appendChild(el('button', { type: 'button', class: 'btn block', onclick: function (e) {
        var b = e.currentTarget; b.disabled = true; b.textContent = 'Recherche…';
        geocodeNearest(q, d).then(function (pl) {
          var x = byId(it.id);
          if (pl && x) { x.place = pl; x.query = q; x.locationText = ''; save(); render(); onRouteToast(pl); closeSheet(); }
          else { b.disabled = false; b.textContent = 'Aucun lieu trouvé sur le trajet'; }
        }).catch(function () { b.disabled = false; b.textContent = 'Recherche impossible, réessayer'; });
      } }, 'Trouver un lieu sur mon trajet du jour'));
    }
  }

  function doMove(it, d, nd, nt) {
    var patch = { date: nd }; if (nt) patch.start = nt;
    var label = frDate(nd, { weekday: 'long', day: 'numeric', month: 'long' }) + (nt ? ' à ' + nt : '');
    withUndo('Déplacé au ' + label, function () { moveOccurrence(it.id, d, patch); });
    buzz(20);
    if (isFixed(it)) {
      // proposer de prévenir la personne, avec la nouvelle date
      var moved = state.items.filter(function (x) { return x.title === it.title && occursOn(x, nd) && (!nt || x.start === nt); })[0];
      if (moved) { sheet.id = moved.id; sheet.item = JSON.parse(JSON.stringify(moved)); }
      sheet.d = nd; sheet.tab = 'notify'; sheet.tpl = 'moved';
      renderSheet();
    } else closeSheet();
  }

  function sheetNotify(body, it, d) {
    var c = contactOf(it);
    var tpl = sheet.tpl || (lateMinutes(it, d) ? 'late' : 'confirm');
    sheet.tpl = tpl;
    var chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Type de message' });
    TEMPLATES.concat(tpl === 'moved' ? [{ id: 'moved', label: 'Nouvelle date' }] : []).forEach(function (t) {
      chips.appendChild(el('button', { type: 'button', class: 'chip', 'aria-pressed': t.id === tpl ? 'true' : 'false', onclick: function () { sheet.tpl = t.id; renderSheet(); } }, t.label));
    });
    body.appendChild(chips);
    var msg = el('textarea', { class: 'msg', id: 'msgText', 'aria-label': 'Message' });
    msg.value = messageFor(tpl, it, d);
    body.appendChild(msg);

    body.appendChild(el('p', { class: 'sectlabel', text: 'Contact' }));
    var ph = el('input', { type: 'tel', id: 'msgPhone', inputmode: 'tel', placeholder: 'Téléphone', value: c.phone, 'aria-label': 'Téléphone du contact' });
    var em = el('input', { type: 'email', id: 'msgEmail', placeholder: 'E-mail', value: c.email, 'aria-label': 'E-mail du contact' });
    body.appendChild(el('div', { class: 'grid2' }, el('div', null, ph), el('div', null, em)));

    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    var aSms = el('a', { class: 'btn primary' }, 'SMS');
    var aMail = el('a', { class: 'btn' }, 'E-mail');
    var aWa = el('a', { class: 'btn', target: '_blank', rel: 'noopener' }, 'WhatsApp');
    var aTel = el('a', { class: 'btn' }, 'Appeler');
    function refresh() {
      var p = ph.value.trim(), e = em.value.trim(), t = msg.value;
      aSms.href = 'sms:' + p.replace(/\s/g, '') + (ios ? '&' : '?') + 'body=' + encodeURIComponent(t);
      aMail.href = 'mailto:' + e + '?subject=' + encodeURIComponent('Mon rendez-vous du ' + whenFr(sheet.fromDate || d, sheet.fromStart || it.start)) + '&body=' + encodeURIComponent(t);
      aWa.href = 'https://wa.me/' + intlPhone(p) + '?text=' + encodeURIComponent(t);
      aTel.href = 'tel:' + p.replace(/\s/g, '');
      aTel.hidden = !p;
    }
    function keepContact() {
      sheet.item.phone = ph.value.trim(); sheet.item.email = em.value.trim();
      if (sheet.item.person) upsertPerson(sheet.item.person, { phone: sheet.item.phone || undefined, email: sheet.item.email || undefined });
      var x = byId(sheet.id); if (!x) return;
      x.phone = sheet.item.phone; x.email = sheet.item.email; save();
    }
    [ph, em].forEach(function (i) { i.addEventListener('input', refresh); i.addEventListener('change', keepContact); });
    msg.addEventListener('input', refresh);
    refresh();
    body.appendChild(el('div', { class: 'channels' }, aSms, aMail, aWa, aTel));
    if (it.source === 'Doctolib' || /doctolib/i.test(it.title)) {
      body.appendChild(el('a', { class: 'btn block', href: 'https://www.doctolib.fr/account/appointments', target: '_blank', rel: 'noopener' }, 'Gérer ce rendez-vous sur Doctolib'));
    }
    body.appendChild(el('p', { class: 'hint', text: 'Votre application de messages s\'ouvre avec le texte déjà écrit : vous vérifiez, puis vous envoyez.' }));
  }

  function sheetCancel(body, it, d) {
    var stillThere = !!byId(sheet.id) && occursOn(byId(sheet.id), d);
    if (stillThere) {
      body.appendChild(el('p', { class: 'hint', text: 'Le rendez-vous sera retiré de votre planning' + (it.repeat !== 'none' ? ' pour ce jour uniquement' : '') + ', et l\'app vous propose ensuite de prévenir la personne.' }));
      body.appendChild(el('button', { type: 'button', class: 'btn dangerfill block', onclick: function () {
        withUndo('« ' + it.title + ' » annulé', function () { removeOccurrence(it.id, d); });
        buzz(30);
        setSheetTab('notify', 'cancel');
      } }, 'Annuler ce rendez-vous'));
    } else {
      body.appendChild(el('p', { class: 'notice', text: 'Ce rendez-vous est déjà annulé.' }));
      body.appendChild(el('button', { type: 'button', class: 'btn primary block', onclick: function () { setSheetTab('notify', 'cancel'); } }, 'Prévenir la personne'));
    }
    if (it.source === 'Doctolib' || /doctolib/i.test(it.title)) {
      body.appendChild(el('p', { class: 'hint', text: 'Pour un rendez-vous Doctolib, annulez-le aussi dans votre compte Doctolib pour libérer le créneau.' }));
      body.appendChild(el('a', { class: 'btn block', href: 'https://www.doctolib.fr/account/appointments', target: '_blank', rel: 'noopener' }, 'Ouvrir mes rendez-vous Doctolib'));
    }
  }

  function sheetMore(body, it, d) {
    var o = planDay(d).out.filter(function (x) { return x.item.id === it.id; })[0];
    var st = o ? o.start : toMin(it.start || state.settings.dayStart), en = o ? o.end : st + (+it.duration || 30);
    var exists = !!byId(sheet.id);
    // Envoyer ce rendez-vous à quelqu'un : il l'ajoute à sa propre app en un tap
    body.appendChild(el('p', { class: 'sectlabel', text: 'Partager ce rendez-vous' }));
    body.appendChild(inviteBox(it, d, fmt(st)));
    var grid = el('div', { class: 'channels' });
    if (exists) {
      grid.appendChild(el('button', { type: 'button', class: 'btn', onclick: function () { closeSheet(); startEdit(it.id); } }, it.repeat !== 'none' ? 'Modifier la série' : 'Modifier'));
      grid.appendChild(el('button', { type: 'button', class: 'btn', onclick: function () {
        var src = byId(it.id);
        withUndo('Dupliqué', function () {
          state.items.push(Object.assign({}, JSON.parse(JSON.stringify(src)), { id: uid(), repeat: 'none', skip: [], doneDates: {}, date: d }));
          save(); render();
        });
        closeSheet();
      } }, 'Dupliquer'));
    }
    grid.appendChild(el('a', { class: 'btn', href: googleCalLink(it, d, st, en), target: '_blank', rel: 'noopener' }, 'Google Agenda'));
    grid.appendChild(el('a', { class: 'btn', href: outlookLink(it, d, st, en), target: '_blank', rel: 'noopener' }, 'Outlook'));
    body.appendChild(grid);
    if (exists) {
      body.appendChild(el('button', { type: 'button', class: 'btn danger block', onclick: function () {
        withUndo(it.repeat !== 'none' ? 'Retiré pour ce jour' : 'Supprimé', function () { removeOccurrence(it.id, d); });
        closeSheet();
      } }, it.repeat !== 'none' ? 'Retirer ce jour' : 'Supprimer'));
    }
  }

  // ================= SOS Journée =================
  var sos = { delay: 30, applied: false };
  function sosResume(delay) { return { date: today(), min: Math.ceil((nowMin() + delay) / 5) * 5 }; }
  function sosPreview(delay) {
    var d = today();
    var before = planDay(d);
    var old = state.settings.resume;
    state.settings.resume = sosResume(delay);
    var after;
    try { after = planDay(d); } finally { state.settings.resume = old; }
    var beforeStart = {};
    before.out.forEach(function (o) { beforeStart[o.item.id] = o.start; });
    var lines = [];
    after.out.forEach(function (o) {
      if (o.past || o.ongoing || o.item.done) return;
      if (isFixed(o.item)) {
        if (o.lateBy > 0) lines.push({ kind: 'warn', id: o.item.id, text: o.item.title + ' à ' + o.item.start + ' : retard d\'environ ' + o.lateBy + ' min' });
        else lines.push({ kind: 'keep', text: o.item.title + ' à ' + o.item.start + ' conservé' });
      } else if (beforeStart[o.item.id] !== undefined && beforeStart[o.item.id] !== o.start) {
        lines.push({ kind: 'move', text: o.item.title + ' : ' + fmt(beforeStart[o.item.id]) + ' → ' + fmt(o.start) });
      } else if (beforeStart[o.item.id] === undefined) {
        lines.push({ kind: 'move', text: o.item.title + ' replacé à ' + fmt(o.start) });
      }
    });
    var newLeft = after.leftover.filter(function (t) { return !before.leftover.some(function (b) { return b.id === t.id; }); });
    newLeft.forEach(function (t) { lines.push({ kind: 'later', text: t.title + ' reporté à demain' }); });
    return { lines: lines, newLeft: newLeft, after: after };
  }
  // Applique un retard à la journée d'aujourd'hui (utilisé par le SOS et par l'assistant)
  function applySOS(delay, pv) {
    pv = pv || sosPreview(delay);
    var d = today();
    var snap = JSON.stringify(state.items), oldResume = state.settings.resume;
    state.settings.resume = sosResume(delay);
    pv.newLeft.forEach(function (t) { moveOccurrence(t.id, d, { date: addDays(d, 1) }); });
    save(); render();
    toast('Journée réorganisée', function () {
      state.items = JSON.parse(snap); state.settings.resume = oldResume; save(); render(); toast('Action annulée');
    });
    return pv;
  }
  function openSOS() {
    sos = { delay: 30, applied: false, conflicts: [] };
    renderSOS();
    var dl = $('#sos');
    if (!dl.open) { if (dl.showModal) dl.showModal(); else dl.setAttribute('open', ''); }
    buzz(20);
  }
  $('#sosBtn').addEventListener('click', openSOS);
  $('#sosClose').addEventListener('click', function () { $('#sos').close(); });
  $('#sos').addEventListener('click', function (e) { if (e.target === this) this.close(); });

  var KIND_ICON = { keep: '✓', move: '↻', later: '→', warn: '!' };
  function sosLine(l) {
    return el('li', { class: 'sosline ' + l.kind },
      el('span', { class: 'ic', 'aria-hidden': 'true', text: KIND_ICON[l.kind] }),
      el('span', { class: 'tx', text: l.text }),
      l.kind === 'warn' && sos.applied ? el('button', { type: 'button', class: 'btn warn', onclick: function () {
        $('#sos').close(); openSheet(l.id, today(), 'notify', 'late');
      } }, 'Prévenir') : null);
  }
  function renderSOS() {
    var body = $('#sosBody'); body.innerHTML = '';
    if (sos.applied) {
      $('#sosTitle').textContent = 'Nouveau plan appliqué';
      var ul = el('ul', { class: 'soslist' });
      sos.result.forEach(function (l) { ul.appendChild(sosLine(l)); });
      body.appendChild(ul);
      if (sos.result.some(function (l) { return l.kind === 'warn'; })) body.appendChild(el('p', { class: 'hint', text: 'Prévenez les personnes concernées en un tap : le retard est déjà calculé dans le message.' }));
      body.appendChild(el('button', { type: 'button', class: 'btn primary block', onclick: function () { $('#sos').close(); } }, 'Voir ma journée'));
      return;
    }
    $('#sosTitle').textContent = 'Combien de temps avez-vous perdu ?';
    var chips = el('div', { class: 'slots five' });
    [0, 15, 30, 45, 60, 90].forEach(function (m) {
      chips.appendChild(el('button', { type: 'button', class: 'slot', 'aria-pressed': sos.delay === m ? 'true' : 'false', onclick: function () { sos.delay = m; renderSOS(); } },
        el('strong', { text: m ? '+' + m : '0' }), el('small', { text: m ? 'min' : 'repartir' })));
    });
    body.appendChild(chips);
    var pv = sosPreview(sos.delay);
    body.appendChild(el('p', { class: 'sectlabel', text: 'Je reprends à ' + fmt(sosResume(sos.delay).min) + ' · voici le nouveau plan' }));
    var ul2 = el('ul', { class: 'soslist' });
    if (!pv.lines.length) ul2.appendChild(el('li', { class: 'hint', text: 'Rien à changer : la suite de la journée tient toujours.' }));
    pv.lines.forEach(function (l) { ul2.appendChild(sosLine(l)); });
    body.appendChild(ul2);
    body.appendChild(el('button', { type: 'button', class: 'btn primary block', onclick: function () {
      applySOS(sos.delay, pv);
      sos.applied = true; sos.result = pv.lines;
      buzz(30);
      renderSOS();
    } }, 'Appliquer ce nouveau plan'));
  }

  // ================= Organiser ma semaine =================
  // Tâches qu'on peut déplacer : flexibles, ponctuelles, pas faites, dans la semaine (à partir d'aujourd'hui).
  // On redistribue celles qui ont une fenêtre (« cette semaine »…) et celles qui ne rentrent pas dans leur jour.
  function planWeek(ws) {
    var days = daysBetween(ws, addDays(ws, 6)).filter(function (d) { return d >= today(); });
    if (!days.length) return { changes: [], stuck: [] };
    var overflow = {};
    days.forEach(function (d) { planDay(d).leftover.forEach(function (t) { overflow[t.id] = true; }); });
    var movable = state.items.filter(function (i) {
      return i.repeat === 'none' && !isFixed(i) && !i.doneDates[i.date] && days.indexOf(i.date) >= 0 && (i.window || overflow[i.id]);
    });
    movable.sort(function (a, b) {
      var pa = a.priority === 'haute' ? 0 : 1, pb = b.priority === 'haute' ? 0 : 1;
      var wa = a.window ? daysBetween(a.window.from, a.window.to).length : 9, wb = b.window ? daysBetween(b.window.from, b.window.to).length : 9;
      return pa - pb || wa - wb || (+b.duration || 0) - (+a.duration || 0);
    });
    var backup = state.items, changes = [], stuck = [];
    state.items = JSON.parse(JSON.stringify(backup));
    try {
      var ids = movable.map(function (m) { return m.id; });
      state.items.forEach(function (i) { if (ids.indexOf(i.id) >= 0) i.date = '0000-00-00'; }); // on les retire d'abord
      var usedByTitle = {};
      movable.forEach(function (m) {
        var allowed = days.filter(function (d) { return !m.window || (d >= m.window.from && d <= m.window.to); });
        if (!m.window) allowed = allowed.filter(function (d) { return d >= m.date; });
        var x = state.items.filter(function (i) { return i.id === m.id; })[0];
        var avoid = usedByTitle[m.title] || [];
        var keep = overflow[m.id] ? null : m.date; // on garde le jour actuel sauf si ça vaut vraiment le coup
        var pick = bestDay(x, allowed, avoid, keep) || bestDay(x, allowed, null, keep);
        x.date = pick || m.date;
        if (!pick) stuck.push(m);
        usedByTitle[m.title] = avoid.concat([x.date]);
        if (x.date !== m.date) changes.push({ id: m.id, title: m.title, from: m.date, to: x.date });
      });
    } finally { state.items = backup; }
    return { changes: changes, stuck: stuck };
  }

  var weekPlan = null;
  $('#organizeWeek').addEventListener('click', function () {
    var ws = weekStart(currentDate);
    weekPlan = planWeek(ws);
    renderWeekDlg(ws, false);
    var dl = $('#weekDlg');
    if (!dl.open) { if (dl.showModal) dl.showModal(); else dl.setAttribute('open', ''); }
    buzz(15);
  });
  $('#weekDlgClose').addEventListener('click', function () { $('#weekDlg').close(); });
  $('#weekDlg').addEventListener('click', function (e) { if (e.target === this) this.close(); });
  function dayShort(d) { return cap(frDate(d, { weekday: 'long', day: 'numeric' })); }
  function renderWeekDlg(ws, applied) {
    var body = $('#weekDlgBody'); body.innerHTML = '';
    $('#weekDlgWhen').textContent = 'Semaine du ' + frDate(ws, { day: 'numeric', month: 'long' });
    var ch = weekPlan.changes;
    $('#weekDlgTitle').textContent = applied ? 'Semaine réorganisée' : (ch.length ? ch.length + ' changement' + (ch.length > 1 ? 's' : '') + ' proposé' + (ch.length > 1 ? 's' : '') : 'Votre semaine est déjà bien organisée');
    var ul = el('ul', { class: 'soslist' });
    ch.forEach(function (c) {
      ul.appendChild(el('li', { class: 'sosline move' }, el('span', { class: 'ic', 'aria-hidden': 'true', text: '↻' }),
        el('span', { class: 'tx', text: c.title + ' : ' + dayShort(c.from) + ' → ' + dayShort(c.to) })));
    });
    weekPlan.stuck.forEach(function (m) {
      ul.appendChild(el('li', { class: 'sosline warn' }, el('span', { class: 'ic', 'aria-hidden': 'true', text: '!' }),
        el('span', { class: 'tx', text: m.title + ' ne rentre nulle part cette semaine' })));
    });
    if (!ch.length && !weekPlan.stuck.length) ul.appendChild(el('li', { class: 'sosline keep' }, el('span', { class: 'ic', 'aria-hidden': 'true', text: '✓' }),
      el('span', { class: 'tx', text: 'Chaque tâche est déjà sur le meilleur jour, et aucun jour ne déborde.' })));
    body.appendChild(ul);
    if (!applied && ch.length) {
      body.appendChild(el('p', { class: 'hint', text: 'Les rendez-vous fixes ne bougent pas. Seules les tâches flexibles changent de jour, pour équilibrer la semaine et limiter les trajets.' }));
      body.appendChild(el('button', { type: 'button', class: 'btn primary block', onclick: function () {
        withUndo('Semaine réorganisée', function () {
          ch.forEach(function (c) { var it = byId(c.id); if (it) it.date = c.to; });
          save(); render();
        });
        buzz(30);
        renderWeekDlg(ws, true);
      } }, 'Appliquer'));
    } else {
      body.appendChild(el('button', { type: 'button', class: 'btn block', onclick: function () { $('#weekDlg').close(); } }, 'Fermer'));
    }
  }

  // Alerte : jours trop chargés dans la semaine, avec une solution par tâche qui déborde
  function renderWeekAlert(ws) {
    var box = $('#weekAlert'); box.innerHTML = '';
    var days = daysBetween(ws, addDays(ws, 6)).filter(function (d) { return d >= today(); });
    var full = [];
    days.forEach(function (d) { var p = planDay(d); if (p.leftover.length) full.push({ d: d, p: p }); });
    box.hidden = !full.length;
    if (!full.length) return;
    box.appendChild(el('div', { class: 'ov-head' },
      el('span', { class: 'ov-badge', text: 'Semaine trop chargée' }),
      el('h2', { text: full.map(function (f) { return cap(frDate(f.d, { weekday: 'long' })); }).join(', ') + (full.length > 1 ? ' débordent' : ' déborde') })));
    var shown = 0;
    full.forEach(function (f) {
      f.p.leftover.forEach(function (t) {
        if (shown >= 3) return;
        var src = byId(t.id);
        if (!src || src.repeat !== 'none') return;
        var target = bestDay(src, days.filter(function (d) { return d !== f.d; }));
        if (!target) return;
        shown++;
        box.appendChild(el('button', { type: 'button', class: 'fix', onclick: function () {
          withUndo('« ' + t.title + ' » déplacé', function () { src.date = target; save(); render(); });
          buzz(20);
        } }, el('span', { text: 'Déplacer « ' + t.title + ' » de ' + frDate(f.d, { weekday: 'long' }) + ' à ' + frDate(target, { weekday: 'long' }) }),
          el('small', { class: 'good', text: 'Rentre sans surcharger ' + frDate(target, { weekday: 'long' }) })));
      });
    });
    if (!shown) box.appendChild(el('p', { class: 'hint', text: 'Aucun autre jour de la semaine n\'a assez de place. Essayez de raccourcir ou de reporter une tâche à la semaine prochaine.' }));
  }

  // ================= Vue Semaine =================
  // ================= Grille de la semaine (style agenda) =================
  var HOUR_PX = 40;
  function weekDisplay() { return state.settings.weekDisplay || 'grid'; }
  function setWeekDisplay(m) { state.settings.weekDisplay = m; save(); render(); }
  $('#wGridBtn').addEventListener('click', function () { setWeekDisplay('grid'); });
  $('#wListBtn').addEventListener('click', function () { setWeekDisplay('list'); });

  function renderWeekGrid(ws) {
    var g = $('#weekGrid'); g.innerHTML = '';
    var s = state.settings;
    var days = daysBetween(ws, addDays(ws, 6));
    var plans = days.map(function (d) { return planDay(d); });
    var m0 = toMin(s.dayStart), m1 = toMin(s.dayEnd);
    plans.forEach(function (p) { p.out.forEach(function (o) { m0 = Math.min(m0, o.start - (o.travel || 0)); m1 = Math.max(m1, o.end); }); });
    var h0 = Math.max(0, Math.floor(m0 / 60)), h1 = Math.min(24, Math.ceil(m1 / 60));
    var height = (h1 - h0) * HOUR_PX;
    var y = function (m) { return (m - h0 * 60) / 60 * HOUR_PX; };

    var head = el('div', { class: 'wg-head' }, el('span', { class: 'wg-corner', 'aria-hidden': 'true' }));
    days.forEach(function (d, i) {
      var p = plans[i], dt = parseDate(d);
      var avail = Math.max(60, m1 - m0);
      var lvl = p.leftover.length ? 'full' : ((p.busy + p.missing) / Math.max(60, toMin(s.dayEnd) - toMin(s.dayStart)) > 0.8 ? 'busy' : (p.out.length ? 'ok' : 'free'));
      head.appendChild(el('button', { type: 'button', class: 'wg-day ' + lvl + (d === today() ? ' today' : '') + (d < today() ? ' past' : ''),
        'aria-label': cap(frDate(d)) + (p.leftover.length ? ', trop chargée' : '') + ' : options de la journée', onclick: function () { openDayMenu(d); } },
        el('small', { text: dt.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '') }),
        el('strong', { text: String(dt.getDate()) }),
        p.leftover.length ? el('span', { class: 'wg-over', text: '+' + p.leftover.length }) : el('span', { class: 'wg-dot', 'aria-hidden': 'true' })));
    });
    g.appendChild(head);

    var body = el('div', { class: 'wg-body', style: 'height:' + height + 'px' });
    var times = el('div', { class: 'wg-times', 'aria-hidden': 'true' });
    for (var h = h0; h < h1; h++) times.appendChild(el('span', { style: 'top:' + y(h * 60) + 'px', text: h + 'h' }));
    body.appendChild(times);
    days.forEach(function (d, i) {
      var col = el('div', { class: 'wg-col' + (d === today() ? ' today' : ''), 'data-date': d, role: 'list', 'aria-label': cap(frDate(d)) });
      plans[i].out.forEach(function (o) {
        var it = o.item, fixed = isFixed(it);
        if (o.travel && !o.past) col.appendChild(el('div', { class: 'wg-travel', 'aria-hidden': 'true', style: 'top:' + y(o.start - o.travel) + 'px;height:' + Math.max(2, o.travel / 60 * HOUR_PX) + 'px' }));
        var blk = el('div', { class: 'wg-blk ' + (fixed ? 'fixed' : 'flex') + (it.done ? ' done' : '') + (it.priority === 'haute' ? ' hot' : ''), role: 'listitem', tabindex: '0',
          'aria-label': fmt(o.start) + ' ' + it.title + (fixed ? ', rendez-vous fixe' : ', tâche flexible'),
          style: 'top:' + y(o.start) + 'px;height:' + Math.max(18, (o.end - o.start) / 60 * HOUR_PX - 2) + 'px' },
          el('b', { text: fmt(o.start) }), el('span', { text: it.title }));
        blk.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(it.id, d, 'move'); } });
        attachGridDrag(blk, it, d, o, { h0: h0 });
        col.appendChild(blk);
      });
      if (d === today()) {
        var n = nowMin();
        if (n >= h0 * 60 && n <= h1 * 60) col.appendChild(el('div', { class: 'wg-now', 'aria-hidden': 'true', style: 'top:' + y(n) + 'px' }));
      }
      body.appendChild(col);
    });
    g.appendChild(body);
  }

  // Appui long puis glisser : vers un autre jour (et une autre heure pour un rendez-vous fixe)
  function attachGridDrag(blk, it, d, o, geo) {
    var timer = null, start = null, drag = null;
    blk.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      start = { x: e.clientX, y: e.clientY };
      try { blk.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      timer = setTimeout(function () { drag = beginDrag(e); }, 300);
    });
    blk.addEventListener('pointermove', function (e) {
      if (!start) return;
      if (!drag) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) {
          clearTimeout(timer);
          if (e.pointerType === 'mouse') drag = beginDrag(e); else start = null;
        }
        return;
      }
      moveDrag(e);
    });
    blk.addEventListener('pointerup', function (e) {
      clearTimeout(timer);
      if (drag) endDrag(e); else if (start) openSheet(it.id, d, 'move');
      start = null; drag = null;
    });
    blk.addEventListener('pointercancel', function () { clearTimeout(timer); if (drag) cleanup(); start = null; drag = null; });

    function beginDrag(e) {
      buzz(25);
      var r = blk.getBoundingClientRect();
      var ghost = blk.cloneNode(true);
      ghost.classList.add('wg-ghost');
      ghost.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
      document.body.appendChild(ghost);
      blk.classList.add('wg-lifted');
      return { ghost: ghost, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width };
    }
    function target(e) {
      var cols = document.querySelectorAll('.wg-col');
      for (var i = 0; i < cols.length; i++) {
        var r = cols[i].getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right) return { col: cols[i], rect: r };
      }
      return null;
    }
    function moveDrag(e) {
      drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
      drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
      document.querySelectorAll('.wg-col.over').forEach(function (c) { c.classList.remove('over'); });
      var t = target(e);
      if (t && t.col.dataset.date >= today()) {
        t.col.classList.add('over');
        if (isFixed(it)) {
          var m = Math.round(((e.clientY - drag.dy - t.rect.top) / HOUR_PX * 60 + geo.h0 * 60) / 15) * 15;
          drag.ghost.querySelector('b').textContent = fmt(Math.max(0, m));
        }
      }
    }
    function cleanup() {
      if (drag && drag.ghost) drag.ghost.remove();
      blk.classList.remove('wg-lifted');
      document.querySelectorAll('.wg-col.over').forEach(function (c) { c.classList.remove('over'); });
    }
    function endDrag(e) {
      var t = target(e);
      var dyOff = drag.dy;
      cleanup();
      if (!t) return;
      var nd = t.col.dataset.date;
      if (nd < today()) { toast('Impossible de déplacer vers un jour passé.'); return; }
      var patch = { date: nd }, label = frDate(nd, { weekday: 'long', day: 'numeric' });
      if (isFixed(it)) {
        var m = Math.round(((e.clientY - dyOff - t.rect.top) / HOUR_PX * 60 + geo.h0 * 60) / 15) * 15;
        m = Math.max(0, Math.min(23 * 60 + 45, m));
        patch.start = fmt(m); label += ' à ' + patch.start;
        if (nd === d && patch.start === it.start) return;
      } else if (nd === d) return;
      withUndo('« ' + it.title + ' » → ' + label, function () { moveOccurrence(it.id, d, patch); });
      buzz(20);
    }
  }

  // ================= Déplacer toute une journée =================
  var dayMenu = { d: null, withFixed: true, done: null };
  function openDayMenu(d) {
    dayMenu = { d: d, withFixed: true, done: null };
    renderDayMenu();
    var dl = $('#weekDlg');
    if (!dl.open) { if (dl.showModal) dl.showModal(); else dl.setAttribute('open', ''); }
    buzz(12);
  }
  function renderDayMenu() {
    var d = dayMenu.d, body = $('#weekDlgBody'); body.innerHTML = '';
    var occ = occurrences(d).filter(function (x) { return !x.done && x.repeat === 'none'; });
    var nRoutine = occurrences(d).filter(function (x) { return !x.done && x.repeat !== 'none'; }).length;
    $('#weekDlgWhen').textContent = 'Toute la journée';
    $('#weekDlgTitle').textContent = cap(frDate(d));

    if (dayMenu.done) {
      $('#weekDlgTitle').textContent = 'Journée déplacée';
      var ul = el('ul', { class: 'soslist' });
      dayMenu.done.moved.forEach(function (m) {
        ul.appendChild(el('li', { class: 'sosline ' + (m.fixed ? 'warn' : 'move') },
          el('span', { class: 'ic', 'aria-hidden': 'true', text: m.fixed ? '!' : '↻' }),
          el('span', { class: 'tx', text: m.title + (m.start ? ' · ' + m.start : '') + ' → ' + frDate(dayMenu.done.to, { weekday: 'long', day: 'numeric' }) }),
          m.fixed && m.id ? el('button', { type: 'button', class: 'btn warn', onclick: function () {
            $('#weekDlg').close();
            openSheet(m.id, dayMenu.done.to, 'notify', 'moved');
            sheet.fromDate = d; sheet.fromStart = m.start; renderSheet();
          } }, 'Prévenir') : null));
      });
      body.appendChild(ul);
      if (dayMenu.done.moved.some(function (m) { return m.fixed; })) body.appendChild(el('p', { class: 'hint', text: 'Pensez à prévenir pour les rendez-vous fixes : le message avec la nouvelle date est prêt.' }));
      body.appendChild(el('button', { type: 'button', class: 'btn primary block', onclick: function () { $('#weekDlg').close(); } }, 'Terminé'));
      return;
    }

    body.appendChild(el('button', { type: 'button', class: 'btn block', onclick: function () { $('#weekDlg').close(); currentDate = d; setMode('day'); } }, 'Voir la journée en détail'));
    if (!occ.length) { body.appendChild(el('p', { class: 'hint', text: nRoutine ? 'Seules des étapes qui se répètent sont prévues ce jour-là. Faites-les glisser une par une pour les déplacer.' : 'Rien à déplacer ce jour-là.' })); return; }
    var nFixed = occ.filter(isFixed).length, nFlex = occ.length - nFixed;
    body.appendChild(el('p', { class: 'sectlabel', text: 'Déplacer toute la journée (' + occ.length + ' étape' + (occ.length > 1 ? 's' : '') + ') vers :' }));
    var ws = weekStart(d);
    var grid = el('div', { class: 'slots' });
    daysBetween(ws, addDays(ws, 13)).filter(function (x) { return x !== d && x >= today(); }).slice(0, 9).forEach(function (x) {
      var p = planDay(x);
      var dt = parseDate(x);
      grid.appendChild(el('button', { type: 'button', class: 'slot', onclick: function () { moveWholeDay(d, x); } },
        el('small', { text: cap(dt.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })) }),
        el('strong', { text: p.out.length ? p.out.length + ' étape' + (p.out.length > 1 ? 's' : '') : 'Libre' })));
    });
    body.appendChild(grid);
    var other = el('input', { type: 'date', id: 'dayMoveDate', min: today(), 'aria-label': 'Autre date' });
    body.appendChild(el('div', { class: 'searchrow' }, other,
      el('button', { type: 'button', class: 'btn', onclick: function () { if (other.value && other.value !== d) moveWholeDay(d, other.value); } }, 'Déplacer')));
    if (nFixed) {
      var cb = el('input', { type: 'checkbox', id: 'dayMoveFixed' });
      cb.checked = dayMenu.withFixed;
      cb.addEventListener('change', function () { dayMenu.withFixed = cb.checked; });
      body.appendChild(el('label', { class: 'check', for: 'dayMoveFixed' }, cb,
        nFixed > 1 ? ' Déplacer aussi les ' + nFixed + ' rendez-vous fixes (même heure)' : ' Déplacer aussi le rendez-vous fixe (même heure)'));
    }
    if (nRoutine) body.appendChild(el('p', { class: 'hint', text: 'Les étapes qui se répètent (travail tous les jours…) restent à leur place. Pour en déplacer une, faites-la glisser.' }));
  }
  function moveWholeDay(from, to) {
    var occ = occurrences(from).filter(function (x) { return !x.done && x.repeat === 'none' && (dayMenu.withFixed || !isFixed(x)); });
    if (!occ.length) return;
    var moved = [];
    withUndo('Journée déplacée au ' + frDate(to, { weekday: 'long', day: 'numeric' }), function () {
      occ.forEach(function (x) {
        moveOccurrence(x.id, from, { date: to });
        var nowItem = state.items.filter(function (i) { return i.title === x.title && occursOn(i, to) && (i.start || '') === (x.start || ''); })[0];
        moved.push({ id: nowItem ? nowItem.id : null, title: x.title, start: x.start, fixed: isFixed(x) });
      });
    });
    buzz(30);
    dayMenu.done = { to: to, moved: moved };
    renderDayMenu();
  }

  // ================= Mes stats : temps gagné, étapes faites, série =================
  function dayGain(d) {
    var occ = occurrences(d);
    if (occ.filter(function (o) { return !isFixed(o); }).length < 1) return 0;
    var p = planDay(d), nv = planDay(d, { naive: true });
    return Math.max(0, nv.totalTravel - p.totalTravel);
  }
  function weekStats(ws) {
    var r = { done: 0, total: 0, travel: 0, gained: 0 };
    daysBetween(ws, addDays(ws, 6)).forEach(function (d) {
      var occ = occurrences(d);
      if (!occ.length) return;
      r.total += occ.length;
      r.done += occ.filter(function (o) { return o.done; }).length;
      r.travel += planDay(d).totalTravel;
      r.gained += dayGain(d);
    });
    return r;
  }
  // Jours d'affilée où tout a été fait (les jours vides ne cassent pas la série)
  function streakDays() {
    var d = today(), n = 0;
    var occT = occurrences(d);
    if (!(occT.length && occT.every(function (o) { return o.done; }))) d = addDays(d, -1);
    for (var i = 0; i < 90; i++, d = addDays(d, -1)) {
      var occ = occurrences(d);
      if (!occ.length) continue;
      if (occ.every(function (o) { return o.done; })) n++; else break;
    }
    return n;
  }
  function renderWeekStats(ws) {
    var box = $('#weekStats'); box.innerHTML = '';
    var st = weekStats(ws);
    box.hidden = !st.total;
    if (!st.total) return;
    var sk = streakDays();
    var tiles = [
      [st.done + '/' + st.total, 'étapes faites'],
      [st.travel ? dur(st.travel) : '0', 'de trajets'],
      [st.gained ? dur(Math.round(st.gained / 5) * 5 || st.gained) : '0 min', 'gagnées grâce à l\'ordre optimisé']
    ];
    var grid = el('div', { class: 'wstats-grid' });
    tiles.forEach(function (t) { grid.appendChild(el('div', { class: 'wstat' }, el('strong', { text: t[0] }), el('span', { text: t[1] }))); });
    box.appendChild(el('p', { class: 'brief-k', text: 'Ta semaine en chiffres' }));
    box.appendChild(grid);
    if (sk >= 2) box.appendChild(el('p', { class: 'streak', text: 'Série : ' + sk + ' jours bouclés d\'affilée. Continue !' }));
  }

  function renderWeek(ws) {
    renderWeekAlert(ws);
    renderWeekStats(ws);
    $('#organizeWeek').hidden = addDays(ws, 6) < today();
    var grid = weekDisplay() === 'grid';
    $('#wGridBtn').setAttribute('aria-selected', grid); $('#wListBtn').setAttribute('aria-selected', !grid);
    $('#weekGrid').hidden = !grid; $('#week').hidden = grid; $('#wGridHint').hidden = !grid;
    if (grid) { renderWeekGrid(ws); return; }
    var box = $('#week'); box.innerHTML = '';
    for (var i = 0; i < 7; i++) {
      (function (d) {
        var occ = occurrences(d).sort(function (a, b) {
          return (isFixed(a) ? toMin(a.start) : 9999) - (isFixed(b) ? toMin(b.start) : 9999);
        });
        var list = el('ul', null);
        if (!occ.length) list.appendChild(el('li', { class: 'wempty', text: 'Libre' }));
        occ.slice(0, 4).forEach(function (o) {
          list.appendChild(el('li', null, el('b', { text: isFixed(o) ? o.start : '·' }), o.title + (o.done ? ' (fait)' : '')));
        });
        if (occ.length > 4) list.appendChild(el('li', { class: 'wempty', text: '+ ' + (occ.length - 4) + ' autre(s)' }));
        var dt = parseDate(d);
        // Jauge de charge : vert = ok, orange = chargée, rouge = trop chargée
        var load = null;
        if (occ.length && d >= today()) {
          var p = planDay(d);
          var avail = toMin(state.settings.dayEnd) - toMin(state.settings.dayStart);
          var ratio = (p.busy + p.missing) / Math.max(60, avail);
          var lvl = p.leftover.length ? 'full' : (ratio > 0.8 ? 'busy' : 'ok');
          load = el('span', { class: 'wload ' + lvl },
            el('span', { class: 'bar' }, el('span', { class: 'fill', style: 'width:' + Math.min(100, Math.round(ratio * 100)) + '%' })),
            el('small', { text: lvl === 'full' ? 'Trop chargée' : (lvl === 'busy' ? 'Chargée' : 'Ça passe') }));
        }
        box.appendChild(el('button', { type: 'button', class: 'wday' + (d === today() ? ' today' : ''), onclick: function () { currentDate = d; setMode('day'); } },
          el('span', { class: 'wdate' }, el('strong', { text: String(dt.getDate()) }), el('span', { text: dt.toLocaleDateString('fr-FR', { weekday: 'short' }) })),
          el('span', { class: 'wmain' }, list, load),
          occ.length ? el('span', { class: 'wcount', text: String(occ.length) }) : null));
      })(addDays(ws, i));
    }
  }

  // ================= Partage et export =================
  function dayText(plan) {
    var lines = [dayLabel(currentDate) + ' — mon programme'];
    plan.out.forEach(function (o) {
      lines.push(fmt(o.start) + '  ' + o.item.title + (placeOf(o.item) ? ' (' + o.item.place.name + ')' : ''));
    });
    lines.push('', 'Organisé avec Ma Journée');
    return lines.join('\n');
  }
  $('#shareBtn').addEventListener('click', function () {
    var text = dayText(planDay(currentDate));
    if (navigator.share) { navigator.share({ title: 'Ma journée', text: text }).catch(function () { /* annulé */ }); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Programme copié, collez-le où vous voulez.'); }, function () { toast('Copie impossible sur cet appareil.'); });
  });
  function icsEscape(s) { return (s || '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n'); }
  // Fichier agenda (.ics) avec une alerte « Il est temps de partir » : le téléphone la déclenche même app fermée
  function exportICS(days, filename) {
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ma Journee//FR', 'CALSCALE:GREGORIAN'];
    var count = 0;
    days.forEach(function (d) {
      planDay(d).out.forEach(function (o) {
        if (o.past || o.item.done) return;
        count++;
        lines.push('BEGIN:VEVENT', 'UID:' + o.item.id + '-' + d + '@ma-journee',
          'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z',
          'DTSTART:' + stamp(d, o.start), 'DTEND:' + stamp(d, o.end),
          'SUMMARY:' + icsEscape(o.item.title));
        if (placeText(o.item)) lines.push('LOCATION:' + icsEscape(placeText(o.item)));
        if (o.item.notes) lines.push('DESCRIPTION:' + icsEscape(o.item.notes));
        var before = o.travel ? o.travel + (+state.settings.buffer || 0) + (o.margin || 0) : 10;
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape(o.travel ? 'Il est temps de partir : ' + o.item.title : 'Bientôt : ' + o.item.title), 'TRIGGER:-PT' + before + 'M', 'END:VALARM');
        lines.push('END:VEVENT');
      });
    });
    lines.push('END:VCALENDAR');
    if (!count) { toast('Rien à venir à ajouter à l\'agenda.'); return; }
    var blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    var a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    toast(count + ' étape(s) prêtes : ouvre le fichier pour les ajouter à l\'agenda de ton téléphone, avec les alertes de départ.');
  }
  $('#exportBtn').addEventListener('click', function () { exportICS([currentDate], 'ma-journee-' + currentDate + '.ics'); });
  $('#icsWeekBtn').addEventListener('click', function () { exportICS(daysBetween(today(), addDays(today(), 6)), 'ma-journee-semaine-' + today() + '.ics'); });

  // ================= Couleur de l'app =================
  var ACCENTS = [['bleu', 'Bleu', '#2347C6'], ['violet', 'Violet', '#6D3FD1'], ['vert', 'Vert', '#0F7A55'], ['orange', 'Orange', '#C2510F'], ['rose', 'Rose', '#C2296B']];
  function applyAccent() {
    var a = state.settings.accent || 'bleu';
    if (a === 'bleu') delete document.documentElement.dataset.accent; else document.documentElement.dataset.accent = a;
    var hex = (ACCENTS.filter(function (x) { return x[0] === a; })[0] || ACCENTS[0])[2];
    var meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.setAttribute('content', hex);
  }
  function renderAccentPicker() {
    var box = $('#accentPicker'); if (!box) return;
    box.innerHTML = '';
    ACCENTS.forEach(function (x) {
      var on = (state.settings.accent || 'bleu') === x[0];
      box.appendChild(el('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-checked': on ? 'true' : 'false', 'aria-label': x[1], style: 'background:' + x[2],
        onclick: function () { state.settings.accent = x[0]; save(); applyAccent(); renderAccentPicker(); } }));
    });
  }

  // ================= Modèles prêts à choisir =================
  var ICONS = {
    work: '<path d="M4 8h16v11H4zM9 8V5h6v3M4 13h16"/>',
    video: '<path d="M3 7h12v10H3zM15 11l6-3v8l-6-3"/>',
    health: '<path d="M12 5v14M5 12h14"/>',
    school: '<path d="M3 9l9-5 9 5-9 5zM7 11v5c3 2 7 2 10 0v-5"/>',
    cart: '<path d="M3 4h2l2 11h11l2-8H6"/><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/>',
    pill: '<path d="M8.5 15.5l7-7"/><path d="M6.5 17.5a3.5 3.5 0 0 1 0-5l6-6a3.5 3.5 0 0 1 5 5l-6 6a3.5 3.5 0 0 1-5 0z"/>',
    bread: '<path d="M4 11a8 5 0 0 1 16 0v7H4z"/>',
    mail: '<path d="M3 6h18v12H3zM3 6l9 7 9-7"/>',
    bank: '<path d="M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18"/>',
    sport: '<path d="M6 8v8M18 8v8M3 10v4M21 10v4M6 12h12"/>',
    scissors: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5l12 9M8 16.5l12-9"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    cal: '<path d="M3 5h18v16H3zM3 10h18M8 3v4M16 3v4"/>'
  };
  var PRESETS = [
    { label: 'Travail', icon: 'work', title: 'Travail', fixed: true, start: '09:00', duration: 480, fav: 'Travail' },
    { label: 'Réunion visio', icon: 'video', title: 'Réunion', fixed: true, start: '10:00', duration: 60, online: true },
    { label: 'Médecin', icon: 'health', title: 'Rendez-vous médecin', fixed: true, start: '', duration: 30 },
    { label: 'Dentiste', icon: 'health', title: 'Dentiste', fixed: true, start: '', duration: 45 },
    { label: 'École / crèche', icon: 'school', title: 'Déposer les enfants', fixed: true, start: '08:30', duration: 15, fav: 'École' },
    { label: 'Courses', icon: 'cart', title: 'Courses', fixed: false, duration: 45, q: 'supermarché' },
    { label: 'Pharmacie', icon: 'pill', title: 'Pharmacie', fixed: false, duration: 15, q: 'pharmacie' },
    { label: 'Boulangerie', icon: 'bread', title: 'Boulangerie', fixed: false, duration: 10, q: 'boulangerie' },
    { label: 'Poste / colis', icon: 'mail', title: 'Passer à la poste', fixed: false, duration: 20, q: 'bureau de poste' },
    { label: 'Banque', icon: 'bank', title: 'Banque', fixed: false, duration: 15, q: 'banque' },
    { label: 'Sport', icon: 'sport', title: 'Sport', fixed: false, duration: 60, fav: 'Sport', q: 'salle de sport' },
    { label: 'Coiffeur', icon: 'scissors', title: 'Coiffeur', fixed: true, start: '', duration: 45 },
    { label: 'Appel', icon: 'phone', title: 'Appeler ', fixed: false, duration: 15, online: true },
    { label: 'Rendez-vous perso', icon: 'cal', title: '', fixed: true, start: '', duration: 60 }
  ];
  var presetQuery = '';
  var activePreset = null;

  function findFav(name) { return state.favorites.filter(function (f) { return norm(f.name) === norm(name); })[0]; }

  // ================= Mes proches (mémoire des personnes) =================
  function findPerson(name) { var n = norm(name); return state.people.filter(function (p) { return norm(p.name) === n; })[0]; }
  function upsertPerson(name, patch) {
    var p = findPerson(name);
    if (!p) { p = { id: uid(), name: cap(name.trim()) }; state.people.push(p); }
    Object.keys(patch || {}).forEach(function (k) { if (patch[k] !== undefined && patch[k] !== '') p[k] = patch[k]; });
    save();
    return p;
  }
  var NOT_A_NAME = /^(Le|La|Les|L|Mon|Ma|Mes|Ton|Ta|Un|Une|Des|Du|De|Moi|Toi|Lui|Elle|Eux|Nous|Vous|Paris|Lyon|Marseille|Demain|Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche)$/;
  // « voir Caro », « déjeuner avec Sam », « appeler Maman », « préviens Léo »
  function personIn(text) {
    var t = ' ' + text.charAt(0).toLowerCase() + text.slice(1);
    var m = t.match(/\s(?:voir|retrouver|rejoindre|rencontrer|appeler|rappeler|t[ée]l[ée]phoner à|d[ée]jeuner avec|d[îi]ner avec|caf[ée] avec|verre avec|sortir avec|avec|pr[ée]viens|pr[ée]venir|dis à|dire à|[ée]cris à|message à|sms à)\s+([A-ZÉÈÀ][A-Za-zÀ-ÿ-]+)/);
    if (!m || NOT_A_NAME.test(m[1])) {
      // un proche déjà connu cité n'importe où (« courses avec Caro »)
      var known = state.people.filter(function (p) { return new RegExp('(^|[^A-Za-zÀ-ÿ])' + p.name + '([^A-Za-zÀ-ÿ]|$)', 'i').test(text); })[0];
      return known ? known.name : null;
    }
    return m[1];
  }

  // ================= Lieux déjà utilisés =================
  function rememberPlace(p) {
    if (!p || p.lat == null) return;
    var list = state.recentPlaces.filter(function (r) { return !(norm(r.name) === norm(p.name) && km(r, p) < 0.05); });
    list.unshift({ name: p.name, label: p.label, lat: p.lat, lon: p.lon, phone: p.phone, hours: p.hours, at: today() });
    state.recentPlaces = list.slice(0, 15);
    save();
  }
  function presetChip(p, onClick, pressable) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[p.icon]; // icônes fixes, définies ci-dessus
    return el('button', { type: 'button', class: 'chip preset', 'aria-pressed': pressable ? (activePreset === p ? 'true' : 'false') : null, onclick: onClick }, svg, p.label);
  }
  function renderPresets() {
    var day = $('#dayPresets'), fm = $('#formPresets');
    day.innerHTML = ''; fm.innerHTML = '';
    PRESETS.forEach(function (p) {
      day.appendChild(presetChip(p, function () { editingId = null; go('add'); applyPreset(p); }, false));
      fm.appendChild(presetChip(p, function () { applyPreset(p); }, true));
    });
  }
  function setPresetHint(nodes) {
    var h = $('#presetHint'); h.innerHTML = '';
    if (!nodes) { h.hidden = true; return; }
    h.hidden = false; h.className = 'notice' + (nodes.warn ? ' warn' : '');
    nodes.parts.forEach(function (n) { h.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); });
  }
  function applyPreset(p) {
    activePreset = p;
    presetQuery = '';
    pickedPlace = null;
    $('#fTitle').value = p.title;
    $('#titleHint').textContent = '';
    form.querySelector('input[value=' + (p.fixed ? 'fixed' : 'flex') + ']').checked = true;
    $('#fStart').value = p.start || '';
    $('#fDeadline').value = '';
    $('#fDuration').value = p.duration;
    $('#fOnline').checked = !!p.online;
    $('#fPlace').value = '';
    $('#fPlaceResults').innerHTML = '';
    setPresetHint(null);
    var fav = p.fav ? findFav(p.fav) : null;
    if (fav) {
      pickedPlace = { name: fav.name, label: fav.label, lat: fav.lat, lon: fav.lon };
      $('#fPlace').value = fav.name;
      if (p.fav === 'Travail' && state.favorites.some(isWorkFav)) setPresetHint({ parts: ['Tu as plusieurs lieux de travail : touche juste au-dessus celui d\'aujourd\'hui.'] });
    } else if (p.q) {
      presetQuery = p.q;
      setPresetHint({ parts: [state.settings.home
        ? 'Le lieu le plus proche de chez vous sera trouvé automatiquement. Vous pouvez aussi en chercher un précis ci-dessous.'
        : 'Indiquez votre point de départ dans Réglages pour que l\'app trouve le lieu le plus proche.'] });
    } else if (p.fav) {
      setPresetHint({ warn: true, parts: ['Votre adresse « ' + p.fav + ' » n\'est pas encore enregistrée. ',
        el('button', { type: 'button', class: 'link-btn', onclick: function () { editPlace(p.fav); } }, 'L\'ajouter dans Mes lieux'),
        ' ou cherchez-la ci-dessous.'] });
    }
    showPicked(); syncKind(); renderPresets();
    var target = !p.title || / $/.test(p.title) ? $('#fTitle') : (p.fixed && !p.start ? $('#fStart') : null);
    if (target) { target.focus(); if (target === $('#fTitle')) target.setSelectionRange(target.value.length, target.value.length); }
  }

  // ================= Formulaire =================
  var form = $('#itemForm');
  function kind() { return form.querySelector('input[name=fKind]:checked').value; }
  function syncKind() {
    var fixed = kind() === 'fixed';
    $('#startWrap').hidden = !fixed; $('#deadlineWrap').hidden = fixed; $('#afterWrap').hidden = fixed;
    $('#fStart').required = fixed;
  }
  form.querySelectorAll('input[name=fKind]').forEach(function (r) { r.addEventListener('change', syncKind); });

  function showPicked() {
    var p = $('#fPicked');
    p.hidden = !pickedPlace;
    if (pickedPlace) {
      $('#fPickedText').textContent = 'Lieu choisi : ' + pickedPlace.label;
      var isFav = state.favorites.some(function (f) { return f.lat === pickedPlace.lat && f.lon === pickedPlace.lon; }) ||
        (state.settings.home && state.settings.home.lat === pickedPlace.lat && state.settings.home.lon === pickedPlace.lon);
      $('.favsave').hidden = isFav;
    }
    renderFavChips();
  }
  function renderFavChips() {
    var box = $('#favChips'); box.innerHTML = '';
    var list = [];
    if (state.settings.home) list.push(Object.assign({}, state.settings.home, { name: 'Domicile' }));
    list = list.concat(state.favorites);
    var shown = function (n) { return norm(n) === 'sport' ? 'Salle de sport' : n; };
    list.forEach(function (f) {
      var on = !!pickedPlace && pickedPlace.lat === f.lat && pickedPlace.lon === f.lon;
      box.appendChild(el('button', { type: 'button', class: 'chip', 'aria-pressed': on ? 'true' : 'false', onclick: function () {
        pickedPlace = { name: f.name, label: f.label, lat: f.lat, lon: f.lon };
        $('#fPlace').value = shown(f.name); $('#fOnline').checked = false; $('#fPlaceResults').innerHTML = '';
        showPicked();
      } }, shown(f.name)));
    });
    // Lieux habituels pas encore définis : un raccourci pour les ajouter
    [['Travail', 'Travail'], ['Sport', 'Salle de sport']].forEach(function (k) {
      if (findFav(k[0])) return;
      box.appendChild(el('button', { type: 'button', class: 'chip ghost', onclick: function () { editPlace(k[0]); } }, '+ ' + k[1]));
    });
    if (!state.settings.home) box.appendChild(el('button', { type: 'button', class: 'chip ghost', onclick: function () { editPlace('home'); } }, '+ Domicile'));
  }
  $('#favSaveBtn').addEventListener('click', function () {
    var name = $('#favName').value.trim();
    if (!pickedPlace) return;
    if (!name) { $('#favName').focus(); return; }
    state.favorites.push({ id: uid(), name: name, label: pickedPlace.label, lat: pickedPlace.lat, lon: pickedPlace.lon });
    pickedPlace = Object.assign({}, pickedPlace, { name: name });
    save(); $('#favName').value = ''; showPicked(); toast('« ' + name + ' » ajouté à vos lieux');
  });

  $('#fTitle').addEventListener('input', function () {
    var m = this.value.match(/(?:^|\s)(?:à\s*)?(\d{1,2})\s*h\s*(\d{2})?\b/i);
    var hint = $('#titleHint');
    if (m && +m[1] < 24) {
      var t = pad(+m[1]) + ':' + (m[2] || '00');
      $('#fStart').value = t;
      form.querySelector('input[value=fixed]').checked = true; syncKind();
      hint.textContent = 'Heure détectée : ' + t;
    } else hint.textContent = '';
  });

  function resetForm() {
    editingId = null; pickedPlace = null;
    form.reset();
    $('#fDate').value = currentDate;
    $('#fDuration').value = 30;
    $('#fPlaceResults').innerHTML = ''; $('#titleHint').textContent = '';
    $('#formEyebrow').textContent = 'Nouveau'; $('#formTitle').textContent = 'Ajouter à mon planning';
    $('#submitBtn').textContent = 'Ajouter'; $('#cancelEdit').hidden = true; $('#deleteBtn').hidden = true;
    presetQuery = ''; activePreset = null; setPresetHint(null); renderPresets();
    showPicked(); syncKind();
  }

  function startEdit(id) {
    var it = byId(id); if (!it) return;
    editingId = id; pickedPlace = it.place || null;
    go('add');
    $('#fTitle').value = it.title;
    form.querySelector('input[value=' + (isFixed(it) ? 'fixed' : 'flex') + ']').checked = true;
    $('#fDate').value = it.date; $('#fStart').value = it.start || ''; $('#fDeadline').value = it.deadline || ''; $('#fAfter').value = it.after || '';
    $('#fDuration').value = it.duration || 30;
    $('#fPriority').value = it.priority || 'normale';
    $('#fRepeat').value = it.repeat || 'none';
    $('#fPlace').value = it.place ? it.place.name : (it.locationText || '');
    $('#fOnline').checked = !!it.online;
    $('#fPhone').value = it.phone || ''; $('#fEmail').value = it.email || '';
    $('#fNotes').value = it.notes || '';
    $('#formEyebrow').textContent = it.repeat !== 'none' ? 'Modifier la série' : 'Modifier';
    $('#formTitle').textContent = it.title;
    $('#submitBtn').textContent = 'Enregistrer'; $('#cancelEdit').hidden = false; $('#deleteBtn').hidden = false;
    $('#deleteBtn').textContent = it.repeat !== 'none' ? 'Supprimer toute la série' : 'Supprimer';
    presetQuery = ''; activePreset = null; setPresetHint(null); renderPresets();
    showPicked(); syncKind();
    if (!it.place && !it.online) $('#fPlace').focus();
  }

  $('#cancelEdit').addEventListener('click', function () { editingId = null; go('day'); });
  $('#deleteBtn').addEventListener('click', function () {
    if (!editingId) return;
    state.items = state.items.filter(function (i) { return i.id !== editingId; });
    editingId = null; save(); go('day'); render(); toast('Supprimé');
  });

  setupSearch($('#fPlace'), $('#fPlaceBtn'), $('#fPlaceResults'), function (p) {
    pickedPlace = p; $('#fOnline').checked = false;
    if (p.phone && !$('#fPhone').value) $('#fPhone').value = p.phone;
    if (p.email && !$('#fEmail').value) $('#fEmail').value = p.email;
    showPicked();
  });
  $('#fPlace').addEventListener('input', function () { if (pickedPlace) { pickedPlace = null; showPicked(); } });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var fixed = kind() === 'fixed';
    var raw = $('#fTitle').value.trim();
    var data = {
      title: raw.replace(/\s+(?:à\s*)?\d{1,2}\s*h\s*(?:\d{2})?\b/i, '').trim() || raw,
      fixed: fixed,
      date: $('#fDate').value,
      start: fixed ? $('#fStart').value : '',
      deadline: fixed ? '' : $('#fDeadline').value,
      after: fixed ? '' : $('#fAfter').value,
      duration: +$('#fDuration').value || 30,
      priority: $('#fPriority').value,
      repeat: $('#fRepeat').value,
      locationText: pickedPlace ? '' : $('#fPlace').value.trim(),
      place: pickedPlace,
      online: $('#fOnline').checked,
      phone: $('#fPhone').value.trim(),
      email: $('#fEmail').value.trim(),
      notes: $('#fNotes').value.trim()
    };
    if (!data.title || !data.date) return;
    var nearestQuery = !data.place && !data.locationText && !data.online ? presetQuery : '';
    presetQuery = '';
    var id = editingId;
    if (id) { Object.assign(byId(id), data); toast('Modifié'); }
    else {
      id = uid();
      state.items.push(Object.assign({ id: id, skip: [], doneDates: {}, source: 'manuel' }, data));
      toast('Ajouté et organisé');
    }
    save();
    editingId = null;
    currentDate = data.date;
    setMode('day');
    go('day');
    if (!data.place && data.locationText && !data.online) findAddress(id);
    if (nearestQuery) {
      var it = byId(id);
      if (!state.settings.home) { it.locationText = nearestQuery; save(); render(); return; }
      toast('Recherche du meilleur lieu sur votre trajet…');
      it.query = nearestQuery;
      geocodeNearest(nearestQuery, data.date).then(function (pl) {
        var x = byId(id); if (!x) return;
        if (pl) { x.place = pl; onRouteToast(pl); } else { x.locationText = nearestQuery; toast('Aucun lieu trouvé tout près. Précisez-le si besoin.'); }
        save(); render();
      }).catch(function () { var x = byId(id); if (x) { x.locationText = nearestQuery; save(); render(); } });
    }
  });

  // ================= Carte =================
  function pinIcon(text, home) {
    return L.divIcon({ className: '', html: '<div class="pin' + (home ? ' home' : '') + '">' + text + '</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
  }
  function renderMap() {
    $('#mapTitle').textContent = 'Carte · ' + dayLabel(currentDate);
    var plan = planDay(currentDate);
    var legend = $('#mapLegend'); legend.innerHTML = '';
    var n = 0;
    plan.out.forEach(function (o) {
      if (!placeOf(o.item)) return;
      n++;
      legend.appendChild(el('div', { class: 'legend' },
        el('span', { class: 'pin', text: String(n) }),
        el('div', null, el('b', { text: fmt(o.start) }), ' ' + o.item.title + ' · ' + o.item.place.name)));
    });
    if (typeof L === 'undefined') { $('#map').textContent = 'Carte indisponible hors connexion.'; return; }
    if (!map) {
      map = L.map('map').setView([46.6, 2.4], 5);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      mapLayer = L.layerGroup().addTo(map);
    }
    setTimeout(function () {
      map.invalidateSize();
      mapLayer.clearLayers();
      var pts = [], home = state.settings.home, k = 0;
      if (home) { L.marker([home.lat, home.lon], { icon: pinIcon('⌂', true), title: 'Départ' }).addTo(mapLayer); pts.push([home.lat, home.lon]); }
      plan.out.forEach(function (o) {
        var p = placeOf(o.item); if (!p) return;
        k++;
        L.marker([p.lat, p.lon], { icon: pinIcon(String(k)), title: o.item.title }).addTo(mapLayer);
        pts.push([p.lat, p.lon]);
      });
      if (home && k) pts.push([home.lat, home.lon]);
      if (pts.length > 1) L.polyline(pts, { color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2347C6', weight: 4, opacity: 0.85 }).addTo(mapLayer);
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15 });
    }, 60);
  }

  // ================= Réglages =================
  function renderSettings() {
    var s = state.settings;
    renderPlaces();
    renderPeople();
    renderAccentPicker();
    $('#sMode').value = s.mode; $('#sStart').value = s.dayStart; $('#sEnd').value = s.dayEnd; $('#sBuffer').value = s.buffer;
    $('#sName').value = s.name || '';
    $('#sMargins').checked = s.smartMargins !== false;
    $('#backupInfo').textContent = s.lastBackup ? 'Dernière sauvegarde : ' + frDate(s.lastBackup, { day: 'numeric', month: 'long', year: 'numeric' }) + '.' : 'Aucune sauvegarde pour l\'instant.';
    renderNotifState();
  }

  // ================= Mes lieux : Domicile, Travail, Salle de sport, École + lieux perso =================
  var PLACE_ICONS = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
    work: '<path d="M4 8h16v11H4zM9 8V5h6v3M4 13h16"/>',
    sport: '<path d="M6 8v8M18 8v8M3 10v4M21 10v4M6 12h12"/>',
    school: '<path d="M3 9l9-5 9 5-9 5zM7 11v5c3 2 7 2 10 0v-5"/>',
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'
  };
  var PLACE_SLOTS = [
    { key: 'home', name: 'Domicile', icon: 'home', hint: 'Ton point de départ et d\'arrivée' },
    { key: 'Travail', name: 'Travail', icon: 'work', hint: 'Bureau, lieu de travail' },
    { key: 'Sport', name: 'Salle de sport', icon: 'sport', hint: 'Salle, piscine, club' },
    { key: 'École', name: 'École / crèche', icon: 'school', hint: 'Études ou enfants' }
  ];
  var placeEdit = null; // clé du lieu en cours de modification ('home', 'Travail', 'Sport', 'École', un id, ou 'new')
  function placeIcon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = PLACE_ICONS[name] || PLACE_ICONS.pin;
    return el('span', { class: 'place-ic' }, svg);
  }
  function savePlace(key, p, customName) {
    if (key === 'home') { state.settings.home = p; setTimeout(function () { loadWeather(true); }, 50); }
    else {
      var isNew = key === 'new' || key === 'newwork';
      var name = isNew ? customName : (PLACE_SLOTS.some(function (s) { return s.key === key; }) ? key : null);
      var existing = name ? null : state.favorites.filter(function (f) { return f.id === key; })[0];
      if (existing) { existing.label = p.label; existing.lat = p.lat; existing.lon = p.lon; name = existing.name; }
      else {
        state.favorites = state.favorites.filter(function (f) { return norm(f.name) !== norm(name); });
        var fav = { id: uid(), name: name, label: p.label, lat: p.lat, lon: p.lon };
        if (key === 'newwork' || key === 'Travail') fav.kind = 'work';
        state.favorites.push(fav);
      }
      // les étapes déjà liées à ce lieu suivent la nouvelle adresse
      state.items.forEach(function (i) { if (i.place && norm(i.place.name) === norm(name)) { i.place = { name: name, label: p.label, lat: p.lat, lon: p.lon }; } });
    }
    placeEdit = null; save(); renderSettings(); render();
    toast('« ' + (key === 'home' ? 'Domicile' : (customName || (PLACE_SLOTS.filter(function (s) { return s.key === key; })[0] || {}).name || 'Lieu')) + ' » enregistré');
  }
  function placeEditor(key, withName) {
    var nameInput = withName ? el('input', { id: 'newPlaceName', placeholder: key === 'newwork' ? 'Nom (ex. Client Dupont, Cabinet 2, Agence Lyon)' : 'Nom (ex. Chez mamie, Piscine)', 'aria-label': 'Nom du lieu' }) : null;
    var search = onbSearch('Adresse ou nom du lieu', function (p) {
      var nm = nameInput ? nameInput.value.trim() : '';
      if (withName && !nm) { nameInput.focus(); toast('Donne un nom à ce lieu.'); return; }
      savePlace(key, p, nm);
    });
    return el('div', { class: 'place-edit' }, nameInput, search, aiBtn('Annuler', function () { placeEdit = null; renderPlaces(); }, 'block'));
  }
  function placeRow(icon, title, sub, isSet, key, onRemove) {
    var row = el('div', { class: 'place-row' + (isSet ? '' : ' unset') },
      placeIcon(icon),
      el('div', { class: 'place-tx' }, el('strong', { text: title }), el('small', { text: sub })),
      el('div', { class: 'place-act' },
        aiBtn(isSet ? 'Modifier' : 'Ajouter', function () { placeEdit = key; renderPlaces(); var i = $('#placesList .place-edit input'); if (i) i.focus(); }, isSet ? '' : 'primary'),
        isSet && onRemove ? el('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Retirer ' + title, onclick: onRemove }, '×') : null));
    var wrap = el('div', { class: 'place-wrap' }, row);
    if (placeEdit === key) wrap.appendChild(placeEditor(key, key === 'new' || key === 'newwork'));
    return wrap;
  }
  function isWorkFav(f) { return f.kind === 'work' && norm(f.name) !== 'travail'; }
  function renderPlaces() {
    var box = $('#placesList'); if (!box) return;
    box.innerHTML = '';
    var s = state.settings;
    PLACE_SLOTS.forEach(function (slot) {
      if (slot.key === 'home') {
        box.appendChild(placeRow(slot.icon, slot.name, s.home ? s.home.label : 'Pas encore défini · ' + slot.hint, !!s.home, 'home', null));
        return;
      }
      var f = findFav(slot.key);
      box.appendChild(placeRow(slot.icon, slot.name, f ? f.label : 'Pas encore défini · ' + slot.hint, !!f, slot.key, f ? function () {
        state.favorites = state.favorites.filter(function (x) { return x.id !== f.id; }); save(); renderSettings();
      } : null));
      if (slot.key === 'Travail') {
        // Autres lieux de travail : clients, cabinets, agences… (médecins, consultants, ingénieurs, artisans)
        state.favorites.filter(isWorkFav).forEach(function (w) {
          box.appendChild(placeRow('work', w.name, w.label, true, w.id, function () {
            state.favorites = state.favorites.filter(function (x) { return x.id !== w.id; }); save(); renderSettings();
          }));
        });
        if (placeEdit === 'newwork') box.appendChild(el('div', { class: 'place-wrap' }, el('p', { class: 'sectlabel', text: 'Autre lieu de travail' }), placeEditor('newwork', true)));
        else if (f) box.appendChild(el('button', { type: 'button', class: 'link-btn add-work', onclick: function () {
          placeEdit = 'newwork'; renderPlaces(); var i = $('#newPlaceName'); if (i) i.focus();
        } }, '+ Un autre lieu de travail (client, cabinet, agence…)'));
      }
    });
    state.favorites.filter(function (f) { return !isWorkFav(f) && !PLACE_SLOTS.some(function (sl) { return norm(sl.key) === norm(f.name); }); }).forEach(function (f) {
      box.appendChild(placeRow('pin', f.name, f.label, true, f.id, function () {
        state.favorites = state.favorites.filter(function (x) { return x.id !== f.id; }); save(); renderSettings();
      }));
    });
    if (placeEdit === 'new') box.appendChild(el('div', { class: 'place-wrap' }, el('p', { class: 'sectlabel', text: 'Nouveau lieu' }), placeEditor('new', true)));
    $('#addPlaceBtn').hidden = placeEdit === 'new';
  }
  $('#addPlaceBtn').addEventListener('click', function () { placeEdit = 'new'; renderPlaces(); var i = $('#newPlaceName'); if (i) i.focus(); });
  // Ouvre Réglages directement sur un lieu à définir (depuis un modèle ou l'assistant)
  function editPlace(key) {
    placeEdit = key; go('settings');
    setTimeout(function () { var b = $('#placesBox'); if (b) b.scrollIntoView({ block: 'start' }); var i = $('#placesList .place-edit input'); if (i) i.focus(); }, 80);
  }
  [['#sMode', 'mode'], ['#sStart', 'dayStart'], ['#sEnd', 'dayEnd'], ['#sBuffer', 'buffer'], ['#sName', 'name']].forEach(function (p) {
    $(p[0]).addEventListener('change', function () { state.settings[p[1]] = p[1] === 'buffer' ? (+this.value || 0) : this.value.trim(); save(); render(); });
  });
  $('#sMargins').addEventListener('change', function () { state.settings.smartMargins = this.checked; save(); render(); });

  // ================= Sauvegarde / restauration =================
  $('#backupBtn').addEventListener('click', function () {
    state.settings.lastBackup = today(); save();
    var data = { app: 'ma-journee', version: 1, savedAt: new Date().toISOString(), state: state };
    var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'ma-journee-sauvegarde-' + today() + '.json' });
    document.body.appendChild(a); a.click(); a.remove();
    renderSettings();
    toast('Sauvegarde créée. Gardez ce fichier en lieu sûr (il contient vos rendez-vous).');
  });
  var pendingRestore = null;
  $('#restoreFile').addEventListener('change', function () {
    var file = this.files && this.files[0]; if (!file) return;
    var input = this;
    var reader = new FileReader();
    reader.onload = function () {
      input.value = '';
      var data;
      try { data = JSON.parse(String(reader.result)); } catch (e) { data = null; }
      var s = data && data.app === 'ma-journee' && data.state;
      if (!s || !Array.isArray(s.items)) { toast('Ce fichier n\'est pas une sauvegarde de Ma Journée.'); return; }
      pendingRestore = s;
      $('#restoreText').textContent = 'Sauvegarde du ' + new Date(data.savedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) +
        ' : ' + s.items.length + ' rendez-vous et tâches, ' + (s.favorites || []).length + ' lieux favoris. Elle remplacera vos données actuelles.';
      $('#restoreConfirm').hidden = false;
    };
    reader.readAsText(file);
  });
  $('#restoreNo').addEventListener('click', function () { pendingRestore = null; $('#restoreConfirm').hidden = true; });
  $('#restoreYes').addEventListener('click', function () {
    if (!pendingRestore) return;
    try { localStorage.setItem(KEY, JSON.stringify(pendingRestore)); } catch (e) { /* ignore */ }
    state = load();
    pendingRestore = null; $('#restoreConfirm').hidden = true;
    renderSettings(); render(); toast('Données restaurées');
  });
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* stockage persistant non disponible */ }

  $('#wipeBtn').addEventListener('click', function () { $('#wipeConfirm').hidden = false; });
  $('#wipeNo').addEventListener('click', function () { $('#wipeConfirm').hidden = true; });
  $('#wipeYes').addEventListener('click', function () {
    state = { settings: Object.assign({}, DEFAULTS), items: [], favorites: [] };
    save(); $('#wipeConfirm').hidden = true; renderSettings(); render(); toast('Données effacées');
  });

  // ================= Rappels =================
  function renderNotifState() {
    var btn = $('#notifBtn'), txt = $('#notifState');
    if (!('Notification' in window)) { btn.hidden = true; txt.textContent = 'Les rappels ne sont pas disponibles sur ce navigateur.'; return; }
    var on = state.settings.notify && Notification.permission === 'granted';
    btn.textContent = on ? 'Désactiver les rappels' : 'Activer les rappels';
    txt.textContent = on ? 'Rappels activés : un avertissement « Il est temps de partir » arrive avant chaque étape, tant que l\'app est ouverte.'
      : (Notification.permission === 'denied' ? 'Les notifications sont bloquées pour ce site dans les réglages du navigateur.' : 'Recevez « Il est temps de partir » avant chaque étape, tant que l\'app est ouverte.');
  }
  $('#notifBtn').addEventListener('click', function () {
    if (state.settings.notify && Notification.permission === 'granted') { state.settings.notify = false; save(); renderNotifState(); return; }
    Notification.requestPermission().then(function (p) {
      state.settings.notify = p === 'granted'; save(); renderNotifState();
      if (p === 'granted') notify('Rappels activés', 'Vous serez prévenu quand il est temps de partir.');
    });
  });
  function notify(title, body) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(function (r) { r.showNotification(title, { body: body, icon: 'icon.svg' }); });
    } else { try { new Notification(title, { body: body, icon: 'icon.svg' }); } catch (e) { toast(title + ' · ' + body); } }
  }
  function checkReminders() {
    var d = today(), n = nowMin();
    planDay(d).out.forEach(function (o) {
      if (o.item.done || o.past || !o.travel) return;
      var leave = o.leaveAt || (o.start - o.travel);
      var key = o.item.id + d + o.start;
      if (n >= leave - 5 && n < o.start && !notified[key]) {
        notified[key] = true;
        var src = byId(o.item.id);
        var take = src ? packList(src).filter(function (x) { return !packChecked(src, d)[x]; }) : [];
        var msg = o.item.title + ' à ' + fmt(o.start) + ' · ≈ ' + dur(o.travel) + ' de trajet' + (take.length ? '. N\'oubliez pas : ' + take.join(', ') : '');
        toast('Il est temps de partir : ' + msg);
        if (state.settings.notify && 'Notification' in window && Notification.permission === 'granted') notify('Il est temps de partir', msg);
      }
    });
  }

  // ================= Import .ics =================
  function parseICS(text) {
    text = text.replace(/\r?\n[ \t]/g, '');
    var events = [], cur = null;
    text.split(/\r?\n/).forEach(function (line) {
      if (line === 'BEGIN:VEVENT') { cur = {}; return; }
      if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; return; }
      if (!cur) return;
      var i = line.indexOf(':'); if (i < 0) return;
      var key = line.slice(0, i).split(';')[0].toUpperCase();
      if (['DTSTART', 'DTEND', 'SUMMARY', 'LOCATION', 'DESCRIPTION', 'RRULE'].indexOf(key) >= 0) cur[key] = line.slice(i + 1);
    });
    return events;
  }
  function icsUnescape(v) { return (v || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); }
  function icsDate(v) {
    var m = (v || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
    if (!m) return null;
    if (!m[4]) return { allDay: true };
    if (m[7]) return { d: new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))) };
    return { d: new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) };
  }
  var ONLINE = /teams|zoom|meet\.google|webex|en ligne|visio|skype/i;
  function rruleRepeat(r) {
    if (!r) return 'none';
    if (/FREQ=DAILY/.test(r)) return 'daily';
    if (/FREQ=WEEKLY/.test(r) && /BYDAY=MO,TU,WE,TH,FR(;|$)/.test(r)) return 'weekdays';
    if (/FREQ=WEEKLY/.test(r) && !/BYDAY=.*,/.test(r)) return 'weekly';
    return 'none';
  }

  $('#icsFile').addEventListener('change', function () {
    var file = this.files && this.files[0]; if (!file) return;
    var input = this;
    var reader = new FileReader();
    reader.onload = function () {
      var evs = parseICS(String(reader.result));
      var added = [], skipped = 0;
      evs.forEach(function (ev) {
        var st = icsDate(ev.DTSTART); if (!st || st.allDay) { skipped++; return; }
        var en = icsDate(ev.DTEND);
        var title = icsUnescape(ev.SUMMARY) || 'Rendez-vous';
        var loc = icsUnescape(ev.LOCATION);
        var all = title + ' ' + loc + ' ' + icsUnescape(ev.DESCRIPTION);
        var source = /doctolib/i.test(all) ? 'Doctolib' : (/teams/i.test(all) ? 'Teams' : 'agenda importé');
        var date = dateStr(st.d), start = pad(st.d.getHours()) + ':' + pad(st.d.getMinutes());
        if (state.items.some(function (i) { return i.title === title && i.date === date && i.start === start; })) { skipped++; return; }
        var item = {
          id: uid(), title: title, fixed: true, date: date, start: start, deadline: '',
          duration: en && en.d ? Math.max(5, Math.round((en.d - st.d) / 60000)) : 30,
          priority: 'normale', repeat: rruleRepeat(ev.RRULE), skip: [], doneDates: {},
          locationText: loc, place: null, online: ONLINE.test(loc) || (!loc && /teams/i.test(all)), source: source
        };
        var tel = all.match(/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/);
        if (tel) item.phone = tel[0];
        var mail = all.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
        if (mail && !/doctolib|noreply|no-reply/i.test(mail[0])) item.email = mail[0];
        state.items.push(item); added.push(item);
      });
      save(); render();
      var box = $('#importResult'); box.hidden = false;
      box.textContent = added.length + ' rendez-vous importé(s)' + (skipped ? ', ' + skipped + ' ignoré(s) (doublons ou journées entières)' : '') + '.';
      input.value = '';
      var toFind = added.filter(function (i) { return i.locationText && !i.online; }).slice(0, 25);
      if (toFind.length) {
        box.textContent += ' Recherche des adresses…';
        toFind.reduce(function (p, it) { return p.then(function () { return findAddress(it.id); }); }, Promise.resolve())
          .then(function () { box.textContent = box.textContent.replace(' Recherche des adresses…', ' Adresses recherchées.'); });
      }
      var future = added.map(function (i) { return i.date; }).sort().filter(function (d) { return d >= today(); })[0];
      if (future) { currentDate = future; render(); }
    };
    reader.readAsText(file);
  });

  // ================= Exemple =================
  function loadDemo() {
    var d = today(), n = nowMin();
    if (n > 17 * 60) { d = addDays(d, 1); n = 8 * 60; }
    var h1 = Math.max(9, Math.ceil(n / 60) + 1), h2 = Math.min(h1 + 3, 19);
    if (!state.settings.home) state.settings.home = { name: 'Place de la République', label: 'Exemple · Place de la République, Paris', lat: 48.8675, lon: 2.3640 };
    var demo = [
      { title: 'Rendez-vous chez le dentiste', fixed: true, start: pad(h1) + ':00', duration: 45, place: { name: 'Gare de l\'Est (exemple)', label: 'Gare de l\'Est, Paris', lat: 48.8768, lon: 2.3592 } },
      { title: 'Récupérer un colis', fixed: false, duration: 15, place: { name: 'Mairie du 10e (exemple)', label: 'Mairie du 10e arrondissement, Paris', lat: 48.8721, lon: 2.3577 } },
      { title: 'Pharmacie', fixed: false, duration: 15, priority: 'haute', place: { name: 'Canal Saint-Martin (exemple)', label: 'Quai de Valmy, Paris', lat: 48.8710, lon: 2.3655 } },
      { title: 'Réunion d\'équipe', fixed: true, start: pad(h2) + ':00', duration: 30, online: true, source: 'Teams' },
      { title: 'Appeler l\'assurance', fixed: false, duration: 15, online: true, deadline: pad(Math.min(h2 + 2, 20)) + ':00' }
    ];
    demo.forEach(function (x) {
      state.items.push(Object.assign({ id: uid(), date: d, start: '', deadline: '', priority: 'normale', repeat: 'none', skip: [], doneDates: {}, locationText: '', place: null, online: false, source: 'exemple' }, x));
    });
    save(); currentDate = d; setMode('day'); go('day');
    toast('Exemple chargé. Effacez-le quand vous voulez dans Réglages.');
  }
  $('#demoBtn').addEventListener('click', loadDemo);

  // ================= Installation (PWA) =================
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvent = e; $('#installBtn').hidden = false; });
  $('#installBtn').addEventListener('click', function () {
    if (!installEvent) return;
    installEvent.prompt();
    installEvent.userChoice.then(function () { installEvent = null; $('#installBtn').hidden = true; });
  });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* hors ligne non disponible */ });
  }

  // ================= Assistant « Demande à Ma Journée » =================
  // Compréhension locale des demandes (aucune donnée envoyée à une IA externe).
  // Chaque action passe par une carte « Confirmer / Annuler » ; rien n'est annoncé comme fait avant d'être fait.
  var AI_SUGGEST = ['Qu\'est-ce que j\'ai demain ?', 'À quelle heure je dois partir ?', 'J\'ai 20 min de retard', 'Il va pleuvoir ?',
    'Programme ma journée de demain : …', 'Importer une capture d\'écran', 'Trouve une pharmacie sur mon trajet',
    'Organise ma semaine', 'Mon rendez-vous de 15h est annulé', 'Déplace tout mardi à jeudi', 'Qu\'est-ce que je dois prendre ?',
    'Mes stats de la semaine', 'Quand puis-je caser 1h de sport cette semaine ?', 'Réserve un restaurant italien vendredi à 20h', 'Je dois rentrer en urgence'];
  var aiThread = [];
  var aiMsgId = 0;

  function aiLogSave() {
    state.aiLog = aiThread.slice(-60).map(function (m) {
      var c = m.card;
      return { role: m.role, text: m.text, status: c && c.run ? c.status : (m.old ? m.oldStatus : null), summary: c && c.run ? c.summary : (m.old ? m.oldSummary : null) };
    });
    save();
  }
  function aiOpen(prefill) {
    if (!aiThread.length && Array.isArray(state.aiLog)) {
      aiThread = state.aiLog.map(function (m) { return { id: ++aiMsgId, role: m.role, text: m.text, old: true, oldStatus: m.status, oldSummary: m.summary }; });
    }
    var chips = $('#aiChips'); chips.innerHTML = '';
    AI_SUGGEST.forEach(function (s) {
      chips.appendChild(el('button', { type: 'button', class: 'chip', onclick: function () {
        // une suggestion qui se termine par « … » se complète : on la met dans le champ
        if (/…$/.test(s)) { var inp = $('#aiInput'); inp.value = s.replace(/…$/, ''); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
        else aiSubmit(s);
      } }, s));
    });
    aiRender();
    var dl = $('#ai');
    if (!dl.open) { if (dl.showModal) dl.showModal(); else dl.setAttribute('open', ''); }
    if (prefill) $('#aiInput').value = prefill;
    setTimeout(function () { $('#aiInput').focus(); }, 50);
  }
  $('#aiBtn').addEventListener('click', function () { aiOpen(); });
  $('#aiClose').addEventListener('click', function () { $('#ai').close(); });
  $('#aiClear').addEventListener('click', function () { aiThread = []; state.aiLog = []; save(); aiRender(); });
  $('#aiForm').addEventListener('submit', function (e) { e.preventDefault(); aiSubmit($('#aiInput').value); });
  $('#aiInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSubmit(this.value); } });

  // Dictée vocale si le navigateur la propose
  (function () {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    var btn = $('#aiMic'); btn.hidden = false;
    var rec = null;
    btn.addEventListener('click', function () {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = 'fr-FR'; rec.interimResults = true; rec.maxAlternatives = 1;
      var finalText = '';
      btn.classList.add('listening'); btn.setAttribute('aria-label', 'Arrêter la dictée');
      rec.onresult = function (ev) {
        var txt = '';
        for (var i = 0; i < ev.results.length; i++) { txt += ev.results[i][0].transcript; if (ev.results[i].isFinal) finalText = txt; }
        $('#aiInput').value = txt;
      };
      rec.onerror = function () { toast('Dictée indisponible. Vous pouvez écrire votre demande.'); };
      rec.onend = function () {
        btn.classList.remove('listening'); btn.setAttribute('aria-label', 'Dicter ma demande'); rec = null;
        if (finalText.trim()) aiSubmit(finalText);
      };
      try { rec.start(); buzz(15); } catch (err) { rec = null; btn.classList.remove('listening'); }
    });
  })();

  function aiSay(text, card) {
    var m = { id: ++aiMsgId, role: 'ai', text: text, card: card || null };
    if (card) card.status = card.status || 'pending';
    aiThread.push(m); aiLogSave(); aiRender();
    return m;
  }
  function aiSubmit(text) {
    text = (text || '').trim();
    if (!text) return;
    $('#aiInput').value = '';
    aiThread.push({ id: ++aiMsgId, role: 'user', text: text });
    aiRender();
    try { aiHandle(text); } catch (err) { aiSay('Désolé, je n\'ai pas réussi à traiter cette demande. Réessaie en la formulant autrement.'); }
  }

  var STATUS_LABEL = { pending: 'En attente de ta validation', running: 'En cours…', done: 'Fait', failed: 'Échec', cancelled: 'Annulé' };
  function aiRender() {
    var box = $('#aiThread'); box.innerHTML = '';
    if (!aiThread.length) {
      box.appendChild(el('div', { class: 'ai-msg ai', text: 'Dis-moi ce dont tu as besoin, comme à un ami. Par exemple « j\'ai 20 min de retard », « mon rendez-vous de 15h est annulé » ou « trouve une pharmacie sur mon trajet ». Je te montre toujours ce que je vais faire avant de le faire.' }));
    }
    aiThread.forEach(function (m) {
      if (m.text) box.appendChild(el('div', { class: 'ai-msg ' + m.role, text: m.text }));
      if (m.old && m.oldStatus) box.appendChild(el('div', { class: 'ai-card' },
        el('span', { class: 'ai-status ' + m.oldStatus, text: STATUS_LABEL[m.oldStatus] }),
        m.oldSummary ? el('p', { class: 'hint', text: m.oldSummary }) : null));
      if (m.card) box.appendChild(aiCardNode(m));
    });
    box.scrollTop = box.scrollHeight;
  }
  function aiLines(lines) {
    var ul = el('ul', { class: 'soslist' });
    lines.forEach(function (l) {
      ul.appendChild(el('li', { class: 'sosline ' + (l.kind || 'move') },
        el('span', { class: 'ic', 'aria-hidden': 'true', text: KIND_ICON[l.kind || 'move'] || '•' }),
        el('span', { class: 'tx', text: l.text }),
        l.action || null));
    });
    return ul;
  }
  function aiCardNode(m) {
    var c = m.card;
    var node = el('div', { class: 'ai-card' }, c.run ? el('span', { class: 'ai-status ' + c.status, text: STATUS_LABEL[c.status] }) : null);
    if (c.lines && c.lines.length) node.appendChild(aiLines(c.lines));
    if (c.body) c.body.forEach(function (b) { node.appendChild(b); });
    if (c.status === 'pending' && c.run) {
      node.appendChild(el('div', { class: 'btns' },
        el('button', { type: 'button', class: 'btn', onclick: function () { c.status = 'cancelled'; c.summary = 'Rien n\'a été modifié.'; aiLogSave(); aiRender(); } }, 'Annuler'),
        el('button', { type: 'button', class: 'btn primary', onclick: function () { aiRun(m); } }, c.confirm || 'Confirmer')));
    }
    if (c.result) {
      node.appendChild(el('p', { class: 'ai-result', text: c.result }));
      if (c.after) c.after.forEach(function (b) { node.appendChild(b); });
    }
    return node;
  }
  function aiRun(m) {
    var c = m.card;
    c.status = 'running'; aiRender();
    Promise.resolve().then(function () { return c.run(); }).then(function (res) {
      res = res || {};
      c.status = res.failed ? 'failed' : 'done';
      c.result = res.text || (res.failed ? 'L\'action n\'a pas pu être faite.' : 'C\'est fait.');
      c.after = res.after || null;
      c.summary = c.result;
      buzz(25);
    }).catch(function () {
      c.status = 'failed'; c.result = 'Une erreur est survenue, rien n\'a été modifié.'; c.summary = c.result;
    }).then(function () { aiLogSave(); aiRender(); });
  }
  function aiBtn(label, fn, cls) { return el('button', { type: 'button', class: 'btn ' + (cls || ''), onclick: fn }, label); }
  // Prévenir quelqu'un : en un tap si on a son numéro (la messagerie s'ouvre avec le texte prêt, il reste à appuyer sur Envoyer)
  function aiNotifyBtn(id, d, tpl, label, fromDate, fromStart) {
    var openEditor = function () {
      openSheet(id, d, 'notify', tpl);
      if (fromDate) { sheet.fromDate = fromDate; sheet.fromStart = fromStart; renderSheet(); }
    };
    var it = byId(id) || state.items.filter(function (x) { return x.id === id; })[0];
    var c = it ? contactOf(it) : { phone: '', email: '' };
    if (!it || (!c.phone && !c.email)) {
      return el('div', { class: 'stack' }, aiBtn(label || 'Préparer le message', openEditor, 'warn'),
        el('small', { class: 'hint', text: 'Ajoute le numéro du contact dans ce message pour l\'envoyer en un tap la prochaine fois.' }));
    }
    var keep = { fromDate: sheet.fromDate, fromStart: sheet.fromStart };
    if (fromDate) { sheet.fromDate = fromDate; sheet.fromStart = fromStart; }
    var txt = messageFor(tpl, it, d);
    sheet.fromDate = keep.fromDate; sheet.fromStart = keep.fromStart;
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    var who = it.place && it.place.name ? it.place.name : it.title;
    var main = c.phone
      ? el('a', { class: 'btn primary block', href: 'sms:' + c.phone.replace(/\s/g, '') + (ios ? '&' : '?') + 'body=' + encodeURIComponent(txt) }, 'Envoyer le SMS à ' + who)
      : el('a', { class: 'btn primary block', href: 'mailto:' + c.email + '?subject=' + encodeURIComponent('Mon rendez-vous') + '&body=' + encodeURIComponent(txt) }, 'Envoyer l\'e-mail à ' + who);
    return el('div', { class: 'stack' },
      el('p', { class: 'ai-preview', text: '« ' + txt + ' »' }),
      main,
      el('small', { class: 'hint', text: 'Ta messagerie s\'ouvre avec le texte déjà écrit : il ne reste qu\'à appuyer sur Envoyer.' }),
      aiBtn('Modifier le message, WhatsApp ou appeler', openEditor, 'block'));
  }

  // ---------- Petits outils de compréhension ----------
  var DAY_RE = /\b(aujourd'hui|ce soir|ce matin|apres-demain|demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(\s+prochain)?\b/g;
  function aiDays(n) { // toutes les dates citées, dans l'ordre
    var out = [], m, t = today();
    DAY_RE.lastIndex = 0;
    while ((m = DAY_RE.exec(n))) {
      var w = m[1];
      if (w === "aujourd'hui" || w === 'ce soir' || w === 'ce matin') out.push(t);
      else if (w === 'demain') out.push(addDays(t, 1));
      else if (w === 'apres-demain') out.push(addDays(t, 2));
      else out.push(nextDay(t, w, !!m[2]));
    }
    return out;
  }
  function aiTimes(n) {
    var out = [], re = /(\d{1,2})\s*h\s*(\d{2})?\b/g, m;
    while ((m = re.exec(n))) if (+m[1] < 24) out.push(pad(+m[1]) + ':' + (m[2] || '00'));
    return out;
  }
  function aiMinutes(n) {
    var m = n.match(/(\d{1,3})\s*(?:min|minutes?|mn)\b/);
    if (m) return +m[1];
    if (/demi-heure|demi heure/.test(n)) return 30;
    if (/\bune heure\b|\b1 heure\b/.test(n)) return 60;
    m = n.match(/(\d)\s*heures?\b/); if (m) return +m[1] * 60;
    m = n.match(/\b(\d)\s*h\b(?!\s*\d)/); if (m && !/\ba\s*\d{1,2}\s*h/.test(n)) return +m[1] * 60;
    return 0;
  }
  // Trouve l'étape dont parle la phrase (par l'heure ou par un mot du titre)
  function aiFindItem(n, dates, opts) {
    var times = aiTimes(n), best = null;
    dates.forEach(function (d) {
      occurrences(d).forEach(function (o) {
        if (o.done) return;
        if (opts && opts.fixedOnly && !isFixed(o)) return;
        var score = 0;
        if (o.start && times.indexOf(o.start) >= 0) score += 3;
        norm(o.title).split(/[^a-z0-9]+/).forEach(function (w) { if (w.length >= 4 && new RegExp('\\b' + w).test(n)) score += 4; });
        if (/\b(rdv|rendez-vous)\b/.test(n) && isFixed(o)) score += 1;
        if (score > 0 && (!best || score > best.score)) best = { item: o, date: d, score: score };
      });
    });
    return best;
  }
  function aiDayName(d) { var t = today(); return d === t ? 'aujourd\'hui' : (d === addDays(t, 1) ? 'demain' : frDate(d, { weekday: 'long', day: 'numeric' })); }
  // Ce qui change dans la journée si on applique une modification
  function aiDiff(date, change) {
    var before = planDay(date), after = simulate(date, change), lines = [];
    var bs = {}; before.out.forEach(function (o) { bs[o.item.id] = o.start; });
    var as = {}; after.out.forEach(function (o) { as[o.item.id] = o.start; });
    after.out.forEach(function (o) {
      if (o.past || o.item.done || isFixed(o.item)) return;
      if (bs[o.item.id] === undefined) lines.push({ kind: 'keep', text: o.item.title + ' trouve sa place à ' + fmt(o.start) });
      else if (bs[o.item.id] !== o.start) lines.push({ kind: 'move', text: o.item.title + ' : ' + fmt(bs[o.item.id]) + ' → ' + fmt(o.start) });
    });
    after.out.forEach(function (o) { if (isFixed(o.item) && o.lateBy > 0 && !o.past) lines.push({ kind: 'warn', text: o.item.title + ' à ' + o.item.start + ' : retard d\'environ ' + o.lateBy + ' min' }); });
    return { lines: lines, before: before, after: after };
  }

  // ---------- Aiguillage des demandes ----------
  function aiHandle(text) {
    var n = norm(text).replace(/’/g, "'");
    if (/^(salut|bonjour|bonsoir|hello|coucou|hey)\b/.test(n) && n.length < 25) return aiSay('Bonjour ! Dis-moi ce que tu veux organiser : un retard, un rendez-vous annulé, une course à caser, ta semaine…');
    if (/^(merci|super|top|parfait|genial|ok)\b/.test(n) && n.length < 25) return aiSay('Avec plaisir ! Je suis là si ta journée change.');
    // « Préviens Caro que j'ai 10 min de retard », « dis à Sam que j'arrive », « envoie un message à Maman »
    var tell = text.match(/^\s*(?:pr[ée]viens|pr[ée]venir|dis|dire|[ée]cris|écrire|envoie(?:-lui)?(?:\s+un)?(?:\s+(?:message|sms|texto))?|textote)\s+(?:à\s+|a\s+)?([A-ZÉÈÀa-zéèà][A-Za-zÀ-ÿ-]+)/i);
    if (tell && !NOT_A_NAME.test(cap(tell[1])) && !/^(le|la|les|mon|ma|mes|que|qu|un|une|tout|tous)$/i.test(tell[1])) return aiTellPerson(text, cap(tell[1]));
    // « Invite Caro », « envoie le rendez-vous à Caro »
    var inv = text.match(/^\s*(?:invite|inviter|envoie(?:-lui)?\s+(?:le|mon|ce)\s+(?:rdv|rendez-vous|d[ée]jeuner|d[îi]ner|planning)\s+[àa])\s+([A-ZÉÈÀa-zéèà][A-Za-zÀ-ÿ-]+)/i);
    if (inv && !NOT_A_NAME.test(cap(inv[1]))) return aiInvite(cap(inv[1]));
    // « Importer une capture d'écran »
    if (/\b(capture|screenshot|photo d'ecran|scanner)\b/.test(n) && n.length < 60) { $('#shotFile').click(); return aiSay('Choisis la capture d\'écran de ton rendez-vous (Doctolib, SMS, e-mail de confirmation) : je la lis et je l\'ajoute.'); }
    // Questions rapides
    if (/\b(meteo|pleuvoir|pleut|pluie|parapluie|il va faire|quel temps|temperature|fera-t-il|fait-il)\b/.test(n)) return aiWeather(n);
    if (/\b(a quelle heure|quelle heure|quand)\b.*\b(partir|pars|dois partir|je pars|decoller|y aller)\b/.test(n)) return aiLeave();
    if (/(qu'est-ce que|qu'est ce que|quoi)\b.*\b(prendre|emporter|oublier|amener)\b/.test(n)) return aiPack();
    if (/\b(temps gagne|j'ai gagne|mes stats|statistiques|mes chiffres|bilan de (la|ma) semaine)\b/.test(n)) return aiStats();
    // « Programme ma journée (de demain) à ma place : voir Caro à midi, être à Châtelet à 15h, récupérer mon colis »
    var prog = text.match(/^\s*(?:est-ce que tu peux |tu peux |peux-tu )?(?:programme|programmer|organise|organiser|planifie|planifier|prepare|préparer|prépare|fais|faire|remplis|remplir|prevois|prévois)(?:-moi| moi)?\s+(?:toute\s+)?(?:ma|la)\s+(?:journ[ée]e|semaine)\b([^:,.\-–]*)[:,.\-–]\s*(.+)$/i);
    if (prog && prog[2] && prog[2].trim().length > 2) {
      var whenPart = prog[1].replace(/(^|\s)(à ma place|a ma place|pour moi|stp|s'il te pla[iî]t)(?=\s|$)/gi, ' ').replace(/(^|\s)de(?=\s|$)/gi, ' ').trim();
      return aiAdd(whenPart + ' ' + prog[2], norm(whenPart + ' ' + prog[2]), true);
    }
    if (/\b(mails?|e-mails?|emails?|boite (de reception|mail)|courriels?)\b/.test(n)) return aiEmails();
    if (/\b(reserve|reserver|reservation|booker|book)\b/.test(n) || (/\b(restaurant|resto)\b/.test(n) && /\b(trouve|cherche|envie)\b/.test(n))) return aiBooking(text, n);
    if (/\b(retard|en retard|bloque|bloquee|coince|bouchons?|greve|panne|rate (le|mon) (train|bus|metro|rer))\b/.test(n)) return aiLate(n);
    if (/\b(urgence|urgent(e)? .*rentrer|rentrer (chez moi|a la maison)|malade|je dois rentrer)\b/.test(n)) return aiUrgent();
    if (/\b(velo|voiture|a pied|en transports?|marge|je commence|je finis|je termine|ma journee (commence|finit|se termine))\b/.test(n) && /\b(toujours|souvent|maintenant|desormais|d'habitude|surtout|prefere|je me deplace|je prends|plutot|marge|commence|finis|termine)\b/.test(n) && !/\b(rdv|rendez-vous|reunion)\b/.test(n)) return aiPrefs(n);
    if (/\b(annule|annulee|annuler|annulation|n'a plus lieu|n'aura pas lieu|tombe a l'eau)\b/.test(n)) return aiCancel(n);
    if (/\b(deplace|deplacer|decale|decaler|bouge|bouger|move|reporte|reporter|repousse|repousser|avance|avancer|mets?)\b/.test(n) && /\b(tout|toute la journee|ma journee|la journee)\b/.test(n) && aiDays(n).length) return aiMoveDay(n);
    if (/\b(deplace|deplacer|decale|decaler|bouge|bouger|reporte|reporter|repousse|repousser|avance|avancer)\b/.test(n)) return aiMoveItem(n);
    if (/\bsemaine\b/.test(n) && /\b(organise|organiser|optimise|optimiser|equilibre|reequilibre|range|planifie|arrange|ameliore)\b/.test(n)) return aiWeek();
    if (/\b(quand|creneau|creneaux|dispo|disponible|libre|caser|du temps)\b/.test(n) && !/\b(ajoute|mets)\b/.test(n)) return aiFreeSlot(text, n);
    if (/\b(velo|voiture|a pied|transports?|marge|je commence|je finis|je termine|ma journee (commence|finit|se termine))\b/.test(n) && /\b(toujours|souvent|maintenant|desormais|d'habitude|surtout|prefere|je me deplace|je prends|plutot|marge|commence|finis|termine)\b/.test(n)) return aiPrefs(n);
    if (/\bsemaine\b/.test(n) && /(qu'est-ce|quoi|programme|planning|j'ai|resume|recap)/.test(n)) return aiWeekSummary();
    if (/(qu'est-ce que j'ai|qu'est ce que j'ai|j'ai quoi|quoi de prevu|mon programme|mon planning|ma journee|resume|recap|organise|organiser|optimise)/.test(n)) return aiDaySummary(aiDays(n)[0] || today());
    return aiAdd(text, n);
  }

  // ---------- Les actions ----------
  function aiEmails() {
    aiSay('Je ne peux pas encore lire tes e-mails : ça demande une connexion sécurisée à ta messagerie, prévue pour la version Pro.\n\nEn attendant, tu peux importer tes rendez-vous en 2 gestes : dans Doctolib, Outlook ou Google Agenda, choisis « Ajouter à mon agenda » ou « Exporter » (fichier .ics), puis importe le fichier ici.', {
      status: 'done', summary: 'Import par fichier .ics proposé.',
      body: [aiBtn('Importer un fichier agenda', function () { $('#ai').close(); go('settings'); setTimeout(function () { $('#icsFile').scrollIntoView({ block: 'center' }); }, 100); }, 'primary block')]
    });
  }

  function aiLate(n) {
    var min = aiMinutes(n);
    var t = today();
    var remaining = planDay(t).out.filter(function (o) { return !o.past && !o.item.done; });
    if (!remaining.length) return aiSay('Il n\'y a plus rien de prévu pour la suite de ta journée : ton retard ne change rien au planning. Courage !');
    if (!min) {
      var chips = el('div', { class: 'chips' });
      [10, 15, 20, 30, 45, 60].forEach(function (x) { chips.appendChild(el('button', { type: 'button', class: 'chip', onclick: function () { aiSubmit('J\'ai ' + x + ' min de retard'); } }, '+' + x + ' min')); });
      return aiSay('Mince ! Combien de retard environ ?', { status: 'done', summary: 'Question sur la durée du retard.', body: [chips] });
    }
    var pv = sosPreview(min);
    var lines = pv.lines.length ? pv.lines : [{ kind: 'keep', text: 'La suite de la journée tient toujours' }];
    aiSay('Avec ' + min + ' min de retard, voici ta journée réorganisée. Les rendez-vous fixes ne bougent pas.', {
      lines: lines, confirm: 'Réorganiser ma journée',
      run: function () {
        applySOS(min, pv);
        var after = [];
        pv.lines.filter(function (l) { return l.kind === 'warn'; }).forEach(function (l) {
          after.push(el('div', { class: 'ai-opt' }, el('span', { text: l.text }), aiNotifyBtn(l.id, t, 'late', 'Prévenir de mon retard')));
        });
        var nextFixed = planDay(t).out.filter(function (o) { return !o.past && !o.ongoing && !o.item.done && isFixed(o.item); })[0];
        if (!after.length && nextFixed && lateMinutes(nextFixed.item, t)) after.push(el('div', { class: 'ai-opt' }, el('span', { text: nextFixed.item.title + ' à ' + nextFixed.item.start }), aiNotifyBtn(nextFixed.item.id, t, 'late', 'Prévenir de mon retard')));
        var txt = 'C\'est fait : ta journée est réorganisée.';
        if (after.length) txt += ' Prévenir en un tap :';
        else if (nextFixed) txt += ' Ton prochain rendez-vous (' + nextFixed.item.title + ' à ' + nextFixed.item.start + ') tient toujours : personne à prévenir.';
        else txt += ' Aucun rendez-vous fixe n\'est touché : personne à prévenir.';
        return { text: txt, after: after };
      }
    });
  }

  function aiUrgent() {
    var t = today();
    var occ = occurrences(t).filter(function (o) { return !o.done; });
    var plan = planDay(t);
    var upcoming = plan.out.filter(function (o) { return !o.past && !o.item.done; });
    if (!upcoming.length) return aiSay('Rien n\'est prévu pour la suite de ta journée. Rentre tranquillement, prends soin de toi.');
    var flex = upcoming.filter(function (o) { return !isFixed(o.item) && o.item.repeat === 'none'; });
    var fixed = upcoming.filter(function (o) { return isFixed(o.item); });
    var lines = flex.map(function (o) { return { kind: 'later', text: o.item.title + ' reporté à demain' }; })
      .concat(fixed.map(function (o) { return { kind: 'warn', text: o.item.title + ' à ' + o.item.start + ' : à annuler ou déplacer' }; }));
    aiSay('Je m\'occupe de libérer ta journée. Prends soin de toi.', {
      lines: lines, confirm: flex.length ? 'Libérer ma journée' : 'Voir quoi faire',
      run: function () {
        if (flex.length) withUndo(flex.length + ' tâche(s) reportée(s) à demain', function () { flex.forEach(function (o) { moveOccurrence(o.item.id, t, { date: addDays(t, 1) }); }); });
        var after = fixed.map(function (o) {
          return el('div', { class: 'ai-opt' }, el('strong', { text: o.item.start + ' · ' + o.item.title }),
            el('div', { class: 'btns' },
              aiNotifyBtn(o.item.id, t, 'cancel', 'Prévenir que j\'annule'),
              aiBtn('Reprogrammer', function () { openSheet(o.item.id, t, 'move'); })));
        });
        return { text: (flex.length ? 'C\'est fait : ' + flex.length + ' tâche(s) passent à demain.' : 'Tes tâches flexibles étaient déjà à jour.') + (fixed.length ? ' Pour tes rendez-vous, choisis quoi faire :' : ''), after: after };
      }
    });
  }

  function aiCancel(n) {
    var userCancels = /(je dois annuler|j'annule|annule mon|annuler mon|je veux annuler|je ne peux pas|je ne pourrai pas)/.test(n);
    var days = aiDays(n);
    var dates = days.length ? days : [today(), addDays(today(), 1)];
    var hit = aiFindItem(n, dates);
    if (!hit) {
      var list = el('div', { class: 'ai-opts' });
      var d0 = dates[0];
      occurrences(d0).filter(function (o) { return !o.done && isFixed(o); }).slice(0, 6).forEach(function (o) {
        list.appendChild(el('div', { class: 'ai-opt' }, el('strong', { text: o.start + ' · ' + o.title }),
          aiBtn('C\'est celui-là', function () { aiSubmit((userCancels ? 'Je dois annuler ' : 'Annulé : ') + o.title + ' ' + (d0 === today() ? 'aujourd\'hui' : aiDayName(d0)) + ' ' + o.start.replace(':', 'h')); })));
      });
      return aiSay(list.children.length ? 'Lequel de tes rendez-vous ' + aiDayName(d0) + ' ?' : 'Je ne trouve pas ce rendez-vous. Précise son nom ou son heure, par exemple « mon dentiste de 15h demain est annulé ».',
        list.children.length ? { status: 'done', summary: 'Choix du rendez-vous demandé.', body: [list] } : null);
    }
    var it = hit.item, d = hit.date;
    var df = aiDiff(d, function (items) {
      var x = items.filter(function (i) { return i.id === it.id; })[0]; if (!x) return;
      if (x.repeat === 'none') x.date = '0000-00-00'; else x.skip.push(d);
    });
    var freed = +it.duration || 30;
    var lines = [{ kind: 'later', text: it.title + (it.start ? ' (' + it.start + ')' : '') + ' ' + aiDayName(d) + ' : retiré du planning' }].concat(df.lines);
    aiSay(userCancels ? 'D\'accord, j\'annule « ' + it.title + ' » ' + aiDayName(d) + ' et je réorganise.' : 'Je retire « ' + it.title + ' » ' + aiDayName(d) + ' : ça te libère ' + dur(freed) + '.', {
      lines: lines, confirm: 'Retirer et réorganiser',
      run: function () {
        withUndo('« ' + it.title + ' » retiré', function () { removeOccurrence(it.id, d); });
        var after = [];
        if (userCancels) after.push(el('div', { class: 'ai-opt' }, el('span', { text: 'Prévenir ' + (it.place ? it.place.name : 'la personne') + ' ?' }), aiNotifyBtn(it.id, d, 'cancel', 'Préparer le message d\'annulation')));
        if (it.source === 'Doctolib' || /doctolib/i.test(it.title)) after.push(el('a', { class: 'btn block', href: 'https://www.doctolib.fr/account/appointments', target: '_blank', rel: 'noopener' }, 'Annuler aussi sur Doctolib'));
        return { text: 'C\'est fait : « ' + it.title + ' » est retiré et ta journée est réorganisée.', after: after };
      }
    });
  }

  function moveDayItems(from, to, withFixed) {
    var occ = occurrences(from).filter(function (x) { return !x.done && x.repeat === 'none' && (withFixed || !isFixed(x)); });
    var moved = [];
    withUndo('Journée déplacée à ' + aiDayName(to), function () {
      occ.forEach(function (x) {
        moveOccurrence(x.id, from, { date: to });
        moved.push({ id: x.id, title: x.title, start: x.start, fixed: isFixed(x) });
      });
    });
    return moved;
  }
  function aiMoveDay(n) {
    var days = aiDays(n);
    var from = days[0], to = days[1];
    if (!to) {
      var chips = el('div', { class: 'chips' });
      daysBetween(today(), addDays(today(), 7)).filter(function (x) { return x !== from; }).forEach(function (x) {
        chips.appendChild(el('button', { type: 'button', class: 'chip', onclick: function () { aiSubmit('Déplace tout ' + aiDayName(from) + ' à ' + aiDayName(x)); } }, cap(aiDayName(x))));
      });
      return aiSay('Vers quel jour veux-tu déplacer ' + aiDayName(from) + ' ?', { status: 'done', summary: 'Jour d\'arrivée demandé.', body: [chips] });
    }
    var occ = occurrences(from).filter(function (x) { return !x.done && x.repeat === 'none'; });
    var routine = occurrences(from).filter(function (x) { return !x.done && x.repeat !== 'none'; });
    if (!occ.length) return aiSay(routine.length ? 'Il n\'y a que des étapes qui se répètent ' + aiDayName(from) + ' (comme ' + routine[0].title + ') : elles restent à leur place.' : 'Rien n\'est prévu ' + aiDayName(from) + '.');
    var lines = occ.map(function (x) { return { kind: isFixed(x) ? 'warn' : 'move', text: x.title + (x.start ? ' · ' + x.start : '') + ' → ' + aiDayName(to) }; });
    if (routine.length) lines.push({ kind: 'keep', text: routine.map(function (r) { return r.title; }).join(', ') + ' (répété) reste en place' });
    var pTo = simulate(to, function (items) { occ.forEach(function (x) { var y = items.filter(function (i) { return i.id === x.id; })[0]; if (y) y.date = to; }); });
    if (pTo.leftover.length) lines.push({ kind: 'warn', text: cap(aiDayName(to)) + ' sera trop chargé : ' + pTo.leftover.map(function (t) { return t.title; }).join(', ') + ' ne rentre pas' });
    aiSay('Voici ce que je déplace de ' + aiDayName(from) + ' à ' + aiDayName(to) + ' :', {
      lines: lines, confirm: 'Déplacer la journée',
      run: function () {
        var moved = moveDayItems(from, to, true);
        var after = moved.filter(function (m) { return m.fixed; }).map(function (m) {
          return el('div', { class: 'ai-opt' }, el('span', { text: m.title + ' · ' + m.start }), aiNotifyBtn(m.id, to, 'moved', 'Prévenir du changement', from, m.start));
        });
        return { text: 'C\'est fait : ' + moved.length + ' étape(s) déplacée(s) à ' + aiDayName(to) + (after.length ? '. Pense à prévenir pour les rendez-vous :' : '.'), after: after };
      }
    });
  }

  function aiMoveItem(n) {
    var days = aiDays(n), times = aiTimes(n);
    var search = daysBetween(today(), addDays(today(), 13));
    if (days.length) search = [days[0]].concat(search.filter(function (d) { return d !== days[0]; }));
    var hit = aiFindItem(n, search);
    if (!hit) return aiSay('Je ne trouve pas cette étape. Donne son nom, par exemple « décale le dentiste à 17h » ou « reporte la banque à demain ».');
    var it = hit.item, d = hit.date;
    var destDays = days.filter(function (x) { return x !== d; });
    var nd = destDays.length ? destDays[destDays.length - 1] : d;
    var destTimes = times.filter(function (x) { return x !== it.start; });
    var nt = isFixed(it) && destTimes.length ? destTimes[destTimes.length - 1] : '';
    if (/\b(reporte|repousse)\b/.test(n) && nd === d && !nt) nd = addDays(d, 1);
    if (nd === d && !nt) return aiSay('À quel moment veux-tu mettre « ' + it.title + ' » ? Par exemple « à demain » ou « à 17h ».');
    var patch = { date: nd }; if (nt) patch.start = nt;
    var label = aiDayName(nd) + (nt ? ' à ' + nt : (isFixed(it) ? ' à ' + it.start : ''));
    var lines = [{ kind: 'move', text: it.title + ' : ' + aiDayName(d) + (it.start ? ' ' + it.start : '') + ' → ' + label }];
    if (isFixed(it)) {
      var st = toMin(nt || it.start), en = st + (+it.duration || 30);
      occurrences(nd).forEach(function (o) {
        if (o.id === it.id || !isFixed(o)) return;
        var a = toMin(o.start), b = a + (+o.duration || 30);
        if (st < b && en > a) lines.push({ kind: 'warn', text: 'Attention : chevauche « ' + o.title + ' » (' + o.start + ')' });
      });
    }
    aiSay('Je déplace « ' + it.title + ' » :', {
      lines: lines, confirm: 'Déplacer',
      run: function () {
        withUndo('« ' + it.title + ' » → ' + label, function () { moveOccurrence(it.id, d, patch); });
        var moved = state.items.filter(function (x) { return x.title === it.title && occursOn(x, nd) && (!nt || x.start === nt); })[0];
        var after = isFixed(it) && moved ? [el('div', { class: 'ai-opt' }, el('span', { text: 'Prévenir du changement ?' }), aiNotifyBtn(moved.id, nd, 'moved', 'Préparer le message', d, it.start))] : null;
        return { text: 'C\'est fait : « ' + it.title + ' » est maintenant ' + label + '.', after: after };
      }
    });
  }

  function aiWeek() {
    var ws = weekStart(today());
    var wp = planWeek(ws);
    if (!wp.changes.length) return aiSay(wp.stuck.length ? 'Ta semaine est déjà au mieux, mais ' + wp.stuck.map(function (m) { return m.title; }).join(', ') + ' ne rentre nulle part. Tu peux raccourcir ou reporter à la semaine prochaine.' : 'Ta semaine est déjà bien organisée : chaque tâche est sur le meilleur jour et aucun jour ne déborde.');
    var lines = wp.changes.map(function (c) { return { kind: 'move', text: c.title + ' : ' + dayShort(c.from) + ' → ' + dayShort(c.to) }; })
      .concat(wp.stuck.map(function (m) { return { kind: 'warn', text: m.title + ' ne rentre nulle part cette semaine' }; }));
    aiSay('Je propose de rééquilibrer ta semaine pour limiter les trajets et éviter les journées trop chargées. Les rendez-vous fixes ne bougent pas.', {
      lines: lines, confirm: 'Appliquer',
      run: function () {
        withUndo('Semaine réorganisée', function () { wp.changes.forEach(function (c) { var x = byId(c.id); if (x) x.date = c.to; }); save(); render(); });
        return { text: 'C\'est fait : ' + wp.changes.length + ' tâche(s) ont changé de jour.', after: [aiBtn('Voir ma semaine', function () { $('#ai').close(); currentDate = today(); go('week'); }, 'block')] };
      }
    });
  }

  function aiDaySummary(d) {
    var p = planDay(d);
    var steps = p.out.filter(function (o) { return !o.past; });
    var label = cap(aiDayName(d));
    if (!steps.length && !p.leftover.length) return aiSay(label + ', rien de prévu. Tu veux ajouter quelque chose ? Dis-le-moi, par exemple « ' + (d === today() ? 'pharmacie ce soir' : 'courses ' + aiDayName(d)) + ' ».');
    var first = steps[0];
    var leave = first && first.travel ? (first.leaveAt || first.start - first.travel) : null;
    var txt = label + ' : ' + steps.length + ' étape' + (steps.length > 1 ? 's' : '') +
      (steps.length ? ', de ' + fmt(steps[0].start) + ' à ' + fmt(p.finish) : '') +
      (p.totalTravel ? ', environ ' + dur(p.totalTravel) + ' de trajet' : '') + '.' +
      (leave ? ' Départ conseillé à ' + fmt(leave) + '.' : '') +
      (wxSummary(d) ? '\nMétéo : ' + wxSummary(d) + '.' : '');
    var lines = steps.map(function (o) {
      return { kind: isFixed(o.item) ? 'warn' : 'keep', text: fmt(o.start) + ' · ' + o.item.title + (placeOf(o.item) ? ' (' + o.item.place.name + ')' : '') + (o.late ? ' · risque de retard' : '') };
    });
    lines.forEach(function (l) { if (l.kind === 'warn' && l.text.indexOf('risque') < 0) l.kind = 'keep'; });
    var body = [];
    if (p.leftover.length) {
      txt += '\n\nAttention : ' + p.leftover.map(function (t) { return t.title; }).join(', ') + ' ne rentre pas. Voici des compromis :';
      buildFixes(d, p).forEach(function (f) {
        body.push(el('button', { type: 'button', class: 'fix', onclick: function () {
          withUndo('Compromis appliqué', function () { f.apply(); save(); render(); });
          aiSay('C\'est fait : « ' + f.label + ' ».');
        } }, el('span', { text: f.label }), el('small', { class: f.plan && f.plan.leftover.length ? '' : 'good', text: !f.plan ? 'Tout trouve sa place' : (f.plan.leftover.length ? 'Il manquera encore ' + dur(f.plan.missing) : 'Journée faisable') })));
      });
    }
    if (first) {
      var src = byId(first.item.id);
      var take = src ? packList(src).filter(function (x) { return !packChecked(src, d)[x]; }) : [];
      if (take.length) txt += '\n\nPour ' + first.item.title + ', pense à prendre : ' + take.join(', ') + '.';
    }
    body.push(aiBtn('Voir la journée', function () { $('#ai').close(); currentDate = d; go('day'); setMode('day'); }, 'block'));
    aiSay(txt, { status: 'done', summary: txt.split('\n')[0], lines: lines, body: body });
  }

  function aiWeekSummary() {
    var ws = weekStart(today());
    var lines = daysBetween(ws, addDays(ws, 6)).filter(function (d) { return d >= today(); }).map(function (d) {
      var p = planDay(d), c = occurrences(d).length;
      var lvl = p.leftover.length ? 'warn' : (c ? 'keep' : 'later');
      return { kind: lvl, text: cap(frDate(d, { weekday: 'long', day: 'numeric' })) + ' : ' + (c ? c + ' étape' + (c > 1 ? 's' : '') : 'libre') + (p.leftover.length ? ' · trop chargé' : '') };
    });
    aiSay('Ta semaine en un coup d\'œil :', { status: 'done', summary: 'Résumé de la semaine.', lines: lines,
      body: [aiBtn('Organiser ma semaine', function () { aiSubmit('Organise ma semaine'); }, 'primary block'), aiBtn('Voir l\'agenda', function () { $('#ai').close(); currentDate = today(); go('week'); }, 'block')] });
  }

  function aiFreeSlot(text, n) {
    var need = aiMinutes(n) || 60;
    var days = aiDays(n);
    var range = days.length ? days : (/\bsemaine prochaine\b/.test(n) ? daysBetween(addDays(weekStart(today()), 7), addDays(weekStart(today()), 13)) : daysBetween(today(), addDays(weekStart(today()), 6)));
    if (range.length < 2 && !days.length) range = daysBetween(today(), addDays(today(), 6));
    var m = text.match(/(?:pour|faire|caser|placer)\s+(?:\d+\s*(?:h|heures?|min|minutes?)\s+(?:de\s+|d')?)?(?:du |de la |de l'|des |le |la |les |un |une )?([^?,.]{3,30})/i);
    var title = m ? cap(m[1].replace(/\b(cette semaine|semaine prochaine|demain|aujourd'hui|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b.*$/i, '').trim()) : 'Créneau réservé';
    if (!title || title.length < 3) title = 'Créneau réservé';
    var s = state.settings, slots = [];
    range.forEach(function (d) {
      if (slots.length >= 4 || d < today()) return;
      var p = planDay(d);
      var busy = p.out.map(function (o) { return [o.start - (o.travel || 0) - 10, o.end + 10]; }).sort(function (a, b) { return a[0] - b[0]; });
      var cur = Math.max(toMin(s.dayStart), d === today() ? Math.ceil((nowMin() + 15) / 15) * 15 : 0), end = toMin(s.dayEnd);
      busy.forEach(function (b) {
        if (slots.length >= 4) return;
        if (b[0] - cur >= need && cur + need <= end) slots.push({ d: d, start: Math.ceil(cur / 15) * 15 });
        cur = Math.max(cur, b[1]);
      });
      if (slots.filter(function (x) { return x.d === d; }).length === 0 && end - cur >= need && slots.length < 4) slots.push({ d: d, start: Math.ceil(cur / 15) * 15 });
    });
    slots = slots.filter(function (x) { return x.start + need <= toMin(s.dayEnd); }).slice(0, 4);
    if (!slots.length) return aiSay('Je ne trouve pas ' + dur(need) + ' de libre sur cette période. Tu veux que je regarde la semaine prochaine ?');
    var list = el('div', { class: 'ai-opts' });
    slots.forEach(function (sl) {
      list.appendChild(el('div', { class: 'ai-opt' },
        el('strong', { text: cap(aiDayName(sl.d)) + ' à ' + fmt(sl.start) }),
        el('small', { text: dur(need) + ' libres, trajets compris' }),
        aiBtn('Réserver ce créneau pour « ' + title + ' »', function () {
          var item = { id: uid(), title: title, fixed: true, date: sl.d, start: fmt(sl.start), deadline: '', duration: need, priority: 'normale', repeat: 'none', skip: [], doneDates: {}, locationText: '', place: null, online: false, source: 'manuel' };
          withUndo('« ' + title + ' » ajouté ' + aiDayName(sl.d) + ' à ' + fmt(sl.start), function () { state.items.push(item); save(); render(); });
          aiSay('C\'est noté : « ' + title + ' » ' + aiDayName(sl.d) + ' à ' + fmt(sl.start) + '.');
        }, 'primary')));
    });
    aiSay('Voici les créneaux libres de ' + dur(need) + ' :', { status: 'done', summary: slots.length + ' créneau(x) proposé(s).', body: [list] });
  }

  function aiPrefs(n) {
    var changes = [], patch = {};
    var modes = [['velo', 'bicycling', 'à vélo'], ['voiture', 'driving', 'en voiture'], ['a pied', 'walking', 'à pied'], ['transport', 'transit', 'en transports']];
    modes.forEach(function (m) { if (new RegExp('\\b' + m[0]).test(n) && !patch.mode) { patch.mode = m[1]; changes.push({ kind: 'move', text: 'Déplacements : ' + m[2] }); } });
    var mm = n.match(/marge\D{0,20}(\d{1,2})\s*(?:min|minutes?)/); if (mm) { patch.buffer = +mm[1]; changes.push({ kind: 'move', text: 'Marge entre deux étapes : ' + mm[1] + ' min' }); }
    var st = n.match(/(?:je commence|ma journee commence|debut)\D{0,12}(\d{1,2})\s*h\s*(\d{2})?/); if (st) { patch.dayStart = pad(+st[1]) + ':' + (st[2] || '00'); changes.push({ kind: 'move', text: 'Début de journée : ' + patch.dayStart }); }
    var en = n.match(/(?:je finis|je termine|ma journee (?:finit|se termine)|fin)\D{0,12}(\d{1,2})\s*h\s*(\d{2})?/); if (en) { patch.dayEnd = pad(+en[1]) + ':' + (en[2] || '00'); changes.push({ kind: 'move', text: 'Fin de journée : ' + patch.dayEnd }); }
    if (!changes.length) return aiSay('Je n\'ai pas compris quelle préférence changer. Par exemple : « je me déplace surtout à vélo », « marge de 10 min », « je finis à 19h ».');
    aiSay('Je retiens ces préférences (modifiables dans Réglages) :', {
      lines: changes, confirm: 'Enregistrer',
      run: function () { Object.assign(state.settings, patch); save(); render(); return { text: 'C\'est enregistré. Tes trajets et ton planning en tiennent compte.' }; }
    });
  }

  var CUISINES = [['ital', 'italian', 'italien'], ['pizz', 'pizza', 'pizzeria'], ['japon', 'japanese', 'japonais'], ['sushi', 'sushi', 'sushis'], ['chinois', 'chinese', 'chinois'],
    ['indien', 'indian', 'indien'], ['libanais', 'lebanese', 'libanais'], ['mexicain', 'mexican', 'mexicain'], ['burger', 'burger', 'burger'], ['thai', 'thai', 'thaï'], ['francais', 'french', 'français'], ['vegetarien', 'vegetarian', 'végétarien'], ['crepe', 'crepe', 'crêperie']];
  function aiBooking(text, n) {
    var kind = /\bcoiffeur|coiffure|barbier\b/.test(n) ? 'coiffeur' : (/\b(restaurant|resto|table|diner|dejeuner)\b/.test(n) ? 'restaurant' : null);
    var day = aiDays(n)[0] || '', time = aiTimes(n)[0] || '';
    var people = (n.match(/(\d{1,2})\s*(?:personnes?|pers|couverts?)/) || [])[1] || (/\b(a deux|pour deux|deux personnes)\b/.test(n) ? '2' : '');
    var cuisine = CUISINES.filter(function (c) { return n.indexOf(c[0]) >= 0; })[0];
    if (!kind) kind = cuisine ? 'restaurant' : null;
    var crit = [kind ? (kind === 'restaurant' ? 'Restaurant' + (cuisine ? ' ' + cuisine[2] : '') : 'Coiffeur') : 'Réservation', day ? aiDayName(day) : '', time ? 'à ' + time : '', people ? people + ' personnes' : ''].filter(Boolean).join(' · ');
    var intro = 'Je ne peux pas encore réserver à ta place : il faudrait un accès officiel aux systèmes de réservation, prévu plus tard. Je te trouve des adresses, tu réserves en un tap, puis je l\'ajoute à ton planning.';
    if (!kind) return aiSay(intro + '\n\nQue veux-tu réserver ? Par exemple « un restaurant italien vendredi à 20h pour 2 » ou « un coiffeur demain après le travail ».');
    if (!state.settings.home) return aiSay(intro + '\n\nIndique d\'abord ton point de départ dans Réglages pour que je cherche près de chez toi.');
    var m = aiSay(intro + '\n\nRecherche en cours : ' + crit + '…');
    var pts = routePoints(day || today());
    var lats = pts.map(function (p) { return p.lat; }), lons = pts.map(function (p) { return p.lon; });
    var box = '&viewbox=' + (Math.min.apply(null, lons) - 0.03) + ',' + (Math.max.apply(null, lats) + 0.02) + ',' + (Math.max.apply(null, lons) + 0.03) + ',' + (Math.min.apply(null, lats) - 0.02);
    nominatim('limit=40&bounded=1&q=' + encodeURIComponent(kind === 'restaurant' ? 'restaurant' : 'coiffeur') + box).then(function (list) {
      if (cuisine) {
        var filtered = list.filter(function (p) { return p.cuisine && p.cuisine.indexOf(cuisine[1]) >= 0; });
        if (filtered.length) list = filtered;
      }
      list.forEach(function (p) { p._d = detourKm(pts, p); });
      list.sort(function (a, b) { return a._d - b._d; });
      list = list.slice(0, 3);
      if (!list.length) { aiSay('Je n\'ai rien trouvé tout près. Essaie avec un autre quartier ou un autre type de cuisine.'); return; }
      var opts = el('div', { class: 'ai-opts' });
      list.forEach(function (p) {
        var btns = el('div', { class: 'btns' });
        if (p.phone) btns.appendChild(el('a', { class: 'btn', href: 'tel:' + p.phone.replace(/\s/g, '') }, 'Appeler'));
        btns.appendChild(el('a', { class: 'btn', href: p.website || ('https://www.google.com/search?q=' + encodeURIComponent(p.name + ' ' + p.label + ' réservation')), target: '_blank', rel: 'noopener' }, p.website ? 'Site / réserver' : 'Chercher pour réserver'));
        if (day && time) btns.appendChild(aiBtn('Ajouter au planning', function () {
          var item = { id: uid(), title: (kind === 'restaurant' ? 'Restaurant ' : 'Coiffeur ') + p.name + (people ? ' (' + people + ' pers.)' : '') + ' · à confirmer', fixed: true, date: day, start: time, deadline: '',
            duration: kind === 'restaurant' ? 90 : 45, priority: 'normale', repeat: 'none', skip: [], doneDates: {}, locationText: '', place: p, online: false, source: 'manuel', phone: p.phone || '' };
          withUndo('Ajouté au planning (à confirmer)', function () { state.items.push(item); save(); render(); });
          aiSay('Ajouté ' + aiDayName(day) + ' à ' + time + ', marqué « à confirmer ». Une fois la réservation confirmée par l\'établissement, retire la mention dans Modifier.');
        }, 'primary'));
        opts.appendChild(el('div', { class: 'ai-opt' },
          el('strong', { text: p.name }),
          el('small', { text: p.label + (p.cuisine ? ' · ' + p.cuisine.replace(/;/g, ', ') : '') + ' · ' + (p._d < 0.3 ? 'sur ton trajet' : '+' + kmMin(p._d) + ' min de détour') }),
          p.hours ? el('small', { text: 'Horaires (OpenStreetMap) : ' + p.hours }) : null,
          btns));
      });
      aiSay('Voici ' + list.length + ' adresse' + (list.length > 1 ? 's' : '') + ' (' + crit + '). Les disponibilités ne sont pas vérifiées : confirme auprès de l\'établissement.' + (!day || !time ? ' Précise le jour et l\'heure pour que je puisse l\'ajouter à ton planning.' : ''),
        { status: 'done', summary: 'Adresses proposées, réservation à faire par toi.', body: [opts] });
    }).catch(function () { aiSay('La recherche n\'a pas abouti (pas de connexion ?). Réessaie dans un instant.'); });
    return m;
  }

  function aiAdd(text, n, wholeDay) {
    var cleaned = text.replace(/^\s*(?:est-ce que tu peux|tu peux|peux-tu|merci de|stp|s'il te plait)\s+/i, '')
      .replace(/^\s*(?:ajoute(?:r)?|rajoute(?:r)?|mets|mettre|met|prevois|prévois|note|planifie|programme|rappelle-moi de|rappelle moi de|il faut que je|je dois|je veux|j'aimerais|trouve(?:-moi)?|cherche(?:-moi)?)\s+/i, '')
      .replace(/\b(?:sur mon (?:trajet|chemin)|sur le chemin|pres de chez moi|à côté|a cote)\b/gi, ' ')
      .replace(/^\s*(?:une|un|la|le|les|l'|des|du|de la|à la|au)\s+/i, '');
    // « pharmacie et boulangerie demain » : un seul jour cité → il vaut pour tout
    var pa, oneDay = aiDays(n);
    if (oneDay.length === 1 && !/\b(cette semaine|semaine prochaine|chaque|tous les|avant (lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche))\b/.test(n)) {
      var saveDate = currentDate, saveMode = viewMode;
      currentDate = oneDay[0]; viewMode = 'day';
      try {
        pa = planAdd(cleaned.replace(/\b(aujourd'hui|ce soir|ce matin|après-demain|apres-demain|demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(\s+prochain)?\b/gi, ' '));
      } finally { currentDate = saveDate; viewMode = saveMode; }
    } else pa = planAdd(cleaned);
    var recognized = wholeDay || pa.created.some(function (c) { return c.query || c.item.fixed || c.item.window || c.item.place || c.item.online || c.item.locationText; }) ||
      /^(ajoute|rajoute|mets|prevois|note|planifie|programme|rappelle|il faut|je dois|trouve|cherche)/.test(n) || aiDays(n).length;
    if (!pa.created.length || !recognized) {
      return aiSay('Je n\'ai pas bien compris. Voici ce que je sais faire :', { status: 'done', summary: 'Aide affichée.',
        lines: [
          { kind: 'keep', text: '« J\'ai 20 min de retard » : je réorganise et je prépare le message' },
          { kind: 'keep', text: '« Mon rendez-vous de 15h est annulé » : je libère et je réorganise' },
          { kind: 'keep', text: '« Ajoute pharmacie et courses demain » : je trouve les lieux sur ton trajet' },
          { kind: 'keep', text: '« Déplace tout mardi à jeudi », « décale le dentiste à 17h »' },
          { kind: 'keep', text: '« Organise ma semaine », « qu\'est-ce que j\'ai demain ? »' },
          { kind: 'keep', text: '« Quand puis-je caser 1h de sport ? », « réserve un resto vendredi 20h »' }] });
    }
    var lines = pa.created.map(function (c) {
      var it = c.item;
      return { kind: 'keep', text: it.title + ' · ' + aiDayName(it.date) + (it.start ? ' à ' + it.start : '') + (it.repeat !== 'none' ? ' (' + REPEAT_LABEL[it.repeat].toLowerCase() + ')' : '') +
        (c.query ? (state.settings.home ? ' · lieu cherché sur ton trajet' : ' · lieu à préciser') :
          (it.place ? ' · ' + (norm(it.place.name) === 'sport' ? 'Salle de sport' : it.place.name) :
            (it.locationText ? ' · ' + it.locationText + ' (je cherche l\'adresse)' : (it.online ? ' · sans déplacement' : ' · lieu à préciser')))) };
    });
    var dayOf = pa.created[0] ? pa.created[0].item.date : today();
    aiSay(wholeDay ? 'D\'accord, je programme ' + aiDayName(dayOf) + ' à ta place. Voici ce que j\'ai compris :' : 'Je vais ajouter :', {
      lines: lines, confirm: wholeDay ? 'Programmer ma journée' : 'Ajouter',
      run: function () {
        var snapIds = pa.created.map(function (c) { return c.item.id; });
        return commitAdd(pa).then(function (r) {
          toast(snapIds.length + ' élément(s) ajouté(s)', function () { state.items = state.items.filter(function (i) { return snapIds.indexOf(i.id) < 0; }); save(); render(); toast('Action annulée'); });
          var after = [];
          var txt = wholeDay ? 'C\'est programmé. Voici ta journée, dans le meilleur ordre :' : 'C\'est ajouté et organisé.';
          if (!wholeDay && r.found.length) txt += ' ' + r.found.map(function (p) { return p.name + (p.detour ? ' (+' + p.detour + ' min de détour)' : ' (sur ton trajet)'); }).join(', ') + '.';
          if (r.noHome) txt += ' Indique ton point de départ dans Réglages pour que je trouve les lieux.';
          if (wholeDay) {
            // la journée obtenue, étape par étape, avec les départs
            var p = planDay(dayOf);
            var dl = p.out.filter(function (o) { return !o.past; }).map(function (o) {
              var it = o.item, pl = placeOf(it);
              var where = pl ? (norm(pl.name) === 'sport' ? 'Salle de sport' : pl.name) : (it.online ? '' : 'lieu à préciser');
              return { kind: isFixed(it) ? 'keep' : 'move', text: fmt(o.start) + ' · ' + it.title + (where ? ' (' + where + ')' : '') +
                (o.travel ? ' · partir à ' + fmt(o.leaveAt || (o.start - o.travel)) : '') + (pl && pl.detour != null ? (pl.detour <= 2 ? ' · sur ton trajet' : ' · +' + pl.detour + ' min de détour') : '') };
            });
            if (p.leftover.length) dl.push({ kind: 'warn', text: 'Ne rentre pas : ' + p.leftover.map(function (t) { return t.title; }).join(', ') });
            after.push(aiLines(dl));
          }
          // Une étape sans lieu (« voir Caro », un colis dont le point relais n'a pas été trouvé) : on demande où, en un geste
          pa.created.forEach(function (c) {
            var it = byId(c.item.id);
            if (!it || it.place || it.online) return;
            var who = it.person || personIn(it.title);
            var q = who ? 'Où vois-tu ' + who + (it.start ? ' à ' + it.start : '') + ' ?' :
              (/colis|relais/i.test(it.title) ? 'Où récupères-tu ton colis ? (point relais, bureau de poste…)' : 'Où a lieu « ' + it.title + ' » ?');
            after.push(el('div', { class: 'ai-opt' },
              el('strong', { text: q }),
              el('small', { text: 'Un restaurant, une adresse, un commerce… Je calcule le trajet et l\'heure de départ.' }),
              onbSearch('Lieu, adresse, restaurant…', function (pl) {
                var x = byId(it.id); if (!x) return;
                x.place = pl; x.locationText = ''; save(); render();
                var o = planDay(x.date).out.filter(function (q) { return q.item.id === x.id; })[0];
                var far = state.settings.home && km(state.settings.home, pl) > 150;
                var msg = 'Noté : ' + x.title + (x.start ? ' à ' + x.start : '') + ', ' + pl.name + '.' +
                  (far ? ' Attention, ce lieu est à plus de 150 km de chez toi : vérifie que c\'est le bon.' :
                    (o && o.travel ? ' Pars à ' + fmt(o.leaveAt || (o.start - o.travel)) + ' (' + dur(o.travel) + ' de trajet).' : ' Ta journée est réorganisée.'));
                if (who) {
                  // on retient le lieu habituel de ce proche, et on propose d'enregistrer son numéro
                  var per = upsertPerson(who, { place: Object.assign({}, pl) });
                  x.person = per.name; save();
                  msg += ' Je retiens que tu vois souvent ' + per.name + ' là-bas : la prochaine fois, ce sera automatique.';
                  var inv = el('div', { class: 'ai-opt' }, el('strong', { text: 'Envoyer le rendez-vous à ' + per.name + ' ?' }), el('small', { text: 'Elle l\'ajoute à son planning en un tap, avec le lieu.' }));
                  var invSlot = el('div'); inv.appendChild(invSlot);
                  var fillInv = function () { invSlot.innerHTML = ''; invSlot.appendChild(inviteBox(byId(x.id) || x, x.date, x.start)); };
                  fillInv();
                  aiSay(msg, { status: 'done', summary: 'Lieu de ' + per.name + ' retenu.', body: per.phone ? [inv] : [personPhoneForm(per, fillInv), inv] });
                } else aiSay(msg);
              })));
          });
          after.push(aiBtn('Voir la journée', function () { $('#ai').close(); currentDate = dayOf; go('day'); setMode('day'); }, 'block'));
          return { text: txt, after: after };
        });
      }
    });
  }

  // ---------- Proches : numéro, message direct ----------
  function smsHref(phone, txt) {
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return 'sms:' + phone.replace(/\s/g, '') + (ios ? '&' : '?') + 'body=' + encodeURIComponent(txt);
  }
  function personPhoneForm(per, after) {
    var ph = el('input', { type: 'tel', inputmode: 'tel', placeholder: 'Numéro de ' + per.name, 'aria-label': 'Numéro de ' + per.name });
    var box = el('div', { class: 'ai-opt' },
      el('strong', { text: 'Enregistrer le numéro de ' + per.name + ' ?' }),
      el('small', { text: 'Pour la prévenir en un tap la prochaine fois. Il reste sur ton téléphone.' }),
      el('div', { class: 'searchrow' }, ph, aiBtn('Enregistrer', function () {
        var v = ph.value.trim();
        if (!/\d{6,}/.test(v.replace(/\D/g, ''))) { ph.focus(); toast('Numéro incomplet.'); return; }
        upsertPerson(per.name, { phone: v });
        box.innerHTML = '';
        box.appendChild(el('p', { class: 'ai-result', text: 'Numéro de ' + per.name + ' enregistré.' }));
        if (after) after();
      }, 'primary')));
    return box;
  }
  function personSendButtons(per, txt) {
    var wrap = el('div', { class: 'stack' }, el('p', { class: 'ai-preview', text: '« ' + txt + ' »' }));
    var area = el('textarea', { class: 'msg', 'aria-label': 'Message' }); area.value = txt;
    var aSms = el('a', { class: 'btn primary block' }, 'Envoyer le SMS à ' + per.name);
    var aWa = el('a', { class: 'btn block', target: '_blank', rel: 'noopener' }, 'WhatsApp');
    function refresh() { aSms.href = smsHref(per.phone, area.value); aWa.href = 'https://wa.me/' + intlPhone(per.phone) + '?text=' + encodeURIComponent(area.value); }
    area.addEventListener('input', refresh); refresh();
    wrap.innerHTML = '';
    wrap.appendChild(area); wrap.appendChild(aSms);
    wrap.appendChild(el('div', { class: 'channels' }, aWa, el('a', { class: 'btn', href: 'tel:' + per.phone.replace(/\s/g, '') }, 'Appeler')));
    wrap.appendChild(el('small', { class: 'hint', text: 'Ta messagerie s\'ouvre avec le texte : il ne reste qu\'à appuyer sur Envoyer.' }));
    return wrap;
  }
  // « Préviens Caro que j'ai 10 min de retard », « dis à Sam que j'arrive », « écris à Maman »
  function aiTellPerson(text, name) {
    var n = norm(text);
    var per = findPerson(name) || upsertPerson(name, {});
    var rest = (text.match(/\bque?\s+(.+)$/i) || text.match(/\b(?:qu')(.+)$/i) || [])[1] || '';
    var min = aiMinutes(n);
    var txt;
    if (/retard/.test(n)) {
      if (!min) { var o = planDay(today()).out.filter(function (x) { return x.item.person && norm(x.item.person) === norm(per.name) && !x.past; })[0]; min = o ? lateMinutes(o.item, today()) : 0; }
      txt = 'Coucou ' + per.name + ', j\'aurai environ ' + (min || 10) + ' min de retard, désolé !';
    } else if (/\b(j'arrive|arrive)\b/.test(n) && !rest) txt = 'Coucou ' + per.name + ', j\'arrive !';
    else txt = 'Coucou ' + per.name + (rest ? ', ' + rest.replace(/\s*[.!]?$/, '') + '.' : ', ');
    var sendBox = el('div');
    function fill() { sendBox.innerHTML = ''; sendBox.appendChild(personSendButtons(findPerson(per.name), txt)); }
    if (per.phone) fill();
    else sendBox.appendChild(personPhoneForm(per, fill));
    aiSay(per.phone ? 'Voici le message pour ' + per.name + ' :' : 'Je n\'ai pas encore le numéro de ' + per.name + '.', { status: 'done', summary: 'Message préparé pour ' + per.name + '.', body: [sendBox] });
  }

  // ---------- Invitations : envoyer un rendez-vous par lien ----------
  // Le rendez-vous voyage dans le lien lui-même (après le #) : rien ne passe par un serveur.
  function b64urlEncode(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64urlDecode(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }
  function inviteLink(it, d, start) {
    var pl = placeOf(it);
    // Pour la personne invitée, « Voir Caro » devient « Voir Ness »
    var me = state.settings.name || '';
    var title = it.person && me ? it.title.replace(new RegExp(it.person, 'i'), me) : it.title;
    var data = { v: 1, t: title, d: d, s: start || it.start || '', du: +it.duration || 60, n: it.notes || '', f: me };
    if (pl) data.p = { n: pl.name, l: pl.label, a: +(+pl.lat).toFixed(5), o: +(+pl.lon).toFixed(5) };
    return location.origin + location.pathname + '#invite=' + b64urlEncode(JSON.stringify(data));
  }
  function inviteText(it, d, start, toName) {
    var pl = placeOf(it);
    return 'Coucou' + (toName ? ' ' + toName : '') + ' ! ' + (it.person && toName && norm(it.person) === norm(toName) ? 'On se voit ' : cap(it.title) + ' : ') +
      frDate(d, { weekday: 'long', day: 'numeric', month: 'long' }) + (start ? ' à ' + hFr(start) : '') + (pl ? ', ' + pl.name : '') +
      '. Ajoute-le à ton planning en un tap : ' + inviteLink(it, d, start);
  }
  function inviteBox(it, d, start) {
    var per = it.person ? findPerson(it.person) : null;
    var wrap = el('div', { class: 'stack' });
    if (per && per.phone) {
      wrap.appendChild(el('a', { class: 'btn primary block', href: smsHref(per.phone, inviteText(it, d, start, per.name)) }, 'Envoyer l\'invitation à ' + per.name));
    }
    var txt = inviteText(it, d, start, per ? per.name : '');
    if (navigator.share) wrap.appendChild(aiBtn(per && per.phone ? 'Envoyer à quelqu\'un d\'autre' : 'Envoyer l\'invitation', function () {
      navigator.share({ title: it.title, text: txt }).catch(function () { /* annulé */ });
    }, per && per.phone ? 'block' : 'primary block'));
    wrap.appendChild(aiBtn('Copier le lien d\'invitation', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast('Invitation copiée, colle-la dans un message.'); }, function () { toast('Copie impossible sur cet appareil.'); });
    }, 'block'));
    wrap.appendChild(el('small', { class: 'hint', text: 'La personne ouvre le lien et ajoute le rendez-vous à son planning, avec le lieu et le trajet.' }));
    return wrap;
  }
  // À l'ouverture : un lien d'invitation reçu
  var inviteShown = false;
  function checkInvite() {
    var m = location.hash.match(/^#invite=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    var data;
    try { data = JSON.parse(b64urlDecode(m[1])); } catch (e) { data = null; }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    if (!data || !data.t || !/^\d{4}-\d{2}-\d{2}$/.test(data.d || '')) { toast('Ce lien d\'invitation est incomplet.'); return false; }
    inviteShown = true;
    var body = $('#weekDlgBody'); body.innerHTML = '';
    $('#weekDlgWhen').textContent = data.f ? data.f + ' t\'invite' : 'Invitation';
    $('#weekDlgTitle').textContent = data.t;
    var lines = [{ kind: 'keep', text: cap(frDate(data.d, { weekday: 'long', day: 'numeric', month: 'long' })) + (data.s ? ' à ' + data.s : '') + ' · ' + dur(+data.du || 60) }];
    if (data.p) lines.push({ kind: 'keep', text: data.p.n + (data.p.l && data.p.l !== data.p.n ? ' · ' + data.p.l : '') });
    if (data.n) lines.push({ kind: 'keep', text: 'Note : ' + data.n });
    body.appendChild(aiLines(lines));
    var exists = state.items.some(function (i) { return i.title === data.t && i.date === data.d && (i.start || '') === (data.s || ''); });
    var finish = function () { $('#weekDlg').close(); };
    if (exists) body.appendChild(el('p', { class: 'notice', text: 'Ce rendez-vous est déjà dans ton planning.' }));
    else body.appendChild(aiBtn('Ajouter à mon planning', function () {
      var item = { id: uid(), title: data.t, fixed: !!data.s, date: data.d, start: data.s || '', deadline: '', after: '', duration: +data.du || 60,
        priority: 'normale', repeat: 'none', skip: [], doneDates: {}, locationText: '', place: data.p ? { name: data.p.n, label: data.p.l, lat: data.p.a, lon: data.p.o } : null,
        online: false, source: data.f ? 'invitation de ' + data.f : 'invitation', notes: data.n || '', person: data.f || '' };
      withUndo('Ajouté à ton planning', function () { state.items.push(item); save(); });
      if (data.f) upsertPerson(data.f, {});
      currentDate = data.d; setMode('day'); go('day');
      finish();
    }, 'primary block'));
    body.appendChild(aiBtn('Non merci', finish, 'block'));
    var dl = $('#weekDlg');
    if (!dl.open) { if (dl.showModal) dl.showModal(); else dl.setAttribute('open', ''); }
    return true;
  }
  window.addEventListener('hashchange', function () { if (/^#invite=/.test(location.hash)) checkInvite(); });

  // ---------- Réglages : Mes proches ----------
  var personEdit = null;
  function renderPeople() {
    var box = $('#peopleList'); if (!box) return;
    box.innerHTML = '';
    if (!state.people.length && personEdit !== 'new') box.appendChild(el('p', { class: 'hint', text: 'Personne pour l\'instant. Quand tu écris « voir Caro à midi », l\'app retient Caro, son lieu habituel et son numéro.' }));
    state.people.forEach(function (p) {
      var row = el('div', { class: 'place-row' },
        el('span', { class: 'place-ic person', text: p.name.charAt(0).toUpperCase() }),
        el('div', { class: 'place-tx' }, el('strong', { text: p.name }),
          el('small', { text: (p.phone || 'Pas de numéro') + (p.place ? ' · ' + p.place.name : '') })),
        el('div', { class: 'place-act' },
          aiBtn('Modifier', function () { personEdit = p.id; renderPeople(); }),
          el('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Retirer ' + p.name, onclick: function () {
            state.people = state.people.filter(function (x) { return x.id !== p.id; }); save(); renderPeople();
          } }, '×')));
      var wrap = el('div', { class: 'place-wrap' }, row);
      if (personEdit === p.id) wrap.appendChild(personEditor(p));
      box.appendChild(wrap);
    });
    if (personEdit === 'new') box.appendChild(el('div', { class: 'place-wrap' }, el('p', { class: 'sectlabel', text: 'Nouveau proche' }), personEditor(null)));
    $('#addPersonBtn').hidden = personEdit === 'new';
  }
  function personEditor(p) {
    var nm = el('input', { placeholder: 'Prénom', 'aria-label': 'Prénom', value: p ? p.name : '' });
    var ph = el('input', { type: 'tel', inputmode: 'tel', placeholder: 'Téléphone (facultatif)', 'aria-label': 'Téléphone', value: p && p.phone ? p.phone : '' });
    var picked = p && p.place ? p.place : null;
    var pickedTxt = el('small', { class: 'hint', text: picked ? 'Lieu habituel : ' + picked.label : 'Lieu habituel (facultatif) :' });
    var search = onbSearch('Café, bureau, chez elle…', function (pl) { picked = pl; pickedTxt.textContent = 'Lieu habituel : ' + pl.label; });
    return el('div', { class: 'place-edit' }, nm, ph, pickedTxt, search,
      el('div', { class: 'grid2' },
        aiBtn('Annuler', function () { personEdit = null; renderPeople(); }),
        aiBtn('Enregistrer', function () {
          var name = nm.value.trim();
          if (!name) { nm.focus(); return; }
          if (p && norm(p.name) !== norm(name)) p.name = cap(name);
          upsertPerson(name, { phone: ph.value.trim() || undefined, place: picked || undefined });
          personEdit = null; renderPeople(); toast('« ' + cap(name) + ' » enregistré');
        }, 'primary')));
  }
  $('#addPersonBtn').addEventListener('click', function () { personEdit = 'new'; renderPeople(); });

  // ---------- Assistant : questions rapides ----------
  function aiWeather(n) {
    var d = aiDays(n)[0] || today();
    if (!state.settings.home) return aiSay('Indique ton domicile dans Réglages pour que je te donne la météo de chez toi.');
    var day = wxDay(d);
    if (!day) { loadWeather(true); return aiSay('Je récupère la météo… redemande-moi dans quelques secondes.'); }
    var rain = rainFrom(d, d === today() ? nowMin() : 0);
    var txt = cap(aiDayName(d)) + ' : ' + wxSummary(d) + '.';
    if (!rain && rainyDay(d)) txt += ' Un parapluie dans le sac, par précaution.';
    if (rain) {
      txt += ' Prends un parapluie' + (state.settings.mode === 'bicycling' ? ', et privilégie les transports plutôt que le vélo.' : '.');
      var outdoor = planDay(d).out.filter(function (o) { return !o.past && !o.item.done && !isFixed(o.item) && o.travel && o.start >= rain.at - 30; });
      if (outdoor.length) txt += ' Si tu peux, fais ' + outdoor.map(function (o) { return o.item.title.toLowerCase(); }).join(', ') + ' avant ' + fmt(rain.at) + '.';
    }
    aiSay(txt);
  }
  function aiLeave() {
    var t = today(), n = nowMin();
    var next = planDay(t).out.filter(function (o) { return !o.past && !o.ongoing && !o.item.done && o.end > n; })[0];
    if (!next) return aiSay('Plus rien de prévu aujourd\'hui : tu n\'as nulle part où aller !');
    if (!next.travel) return aiSay('Ta prochaine étape, ' + next.item.title + ' à ' + fmt(next.start) + ', se fait sans déplacement.');
    var leave = next.leaveAt || (next.start - next.travel);
    var left = leave - n;
    aiSay((left <= 0 ? 'Tu devrais déjà être parti' + (left < -5 ? ' (depuis ' + dur(-left) + ')' : '') + ' !' : 'Pars à ' + fmt(leave) + ', dans ' + dur(left) + '.') +
      ' Direction ' + next.item.title + ' à ' + fmt(next.start) + (placeOf(next.item) ? ' (' + next.item.place.name + ')' : '') + ', ≈ ' + dur(next.travel) + ' de trajet.',
      placeOf(next.item) ? { status: 'done', summary: 'Heure de départ donnée.', body: [el('a', { class: 'btn primary block', href: mapsLink(next.item), target: '_blank', rel: 'noopener' }, 'Y aller')] } : null);
  }
  function aiPack() {
    var t = today(), n = nowMin();
    var steps = planDay(t).out.filter(function (o) { return !o.past && !o.item.done && o.end > n; });
    var lines = [];
    steps.forEach(function (o) {
      var src = byId(o.item.id); if (!src) return;
      var list = packList(src).filter(function (x) { return !packChecked(src, t)[x]; });
      if (o.travel && isWet(wxAt(t, o.leaveAt || o.start - o.travel))) list = list.concat(['Parapluie']);
      if (list.length) lines.push({ kind: 'keep', text: o.item.title + ' : ' + list.join(', ') });
    });
    if (!lines.length) return aiSay('Rien de spécial à prendre pour la suite de ta journée.');
    aiSay('Pour aujourd\'hui, pense à prendre :', { status: 'done', summary: 'Liste « à prendre ».', lines: lines });
  }
  function aiStats() {
    var st = weekStats(weekStart(today())), sk = streakDays();
    if (!st.total) return aiSay('Rien de prévu cette semaine pour l\'instant, donc pas encore de chiffres !');
    aiSay('Cette semaine : ' + st.done + ' étape(s) faite(s) sur ' + st.total + ', ≈ ' + dur(st.travel || 0) + ' de trajets' +
      (st.gained ? ', et environ ' + dur(st.gained) + ' gagnées grâce à l\'ordre optimisé' : '') + '.' + (sk >= 2 ? ' Et ' + sk + ' jours bouclés d\'affilée, bravo !' : ''));
  }
  function aiInvite(name) {
    var per = findPerson(name);
    var cands = [];
    daysBetween(today(), addDays(today(), 30)).forEach(function (d) {
      occurrences(d).forEach(function (o) {
        if (o.done) return;
        if ((o.person && norm(o.person) === norm(name)) || norm(o.title).indexOf(norm(name)) >= 0) cands.push({ o: o, d: d });
      });
    });
    if (!cands.length) return aiSay('Je ne trouve pas de rendez-vous avec ' + name + ' dans les 30 prochains jours. Ajoute-le d\'abord, par exemple « voir ' + name + ' vendredi à 12h ».');
    var c = cands[0];
    if (!per) upsertPerson(name, {});
    aiSay('Voici l\'invitation pour « ' + c.o.title + ' » (' + aiDayName(c.d) + (c.o.start ? ' à ' + c.o.start : '') + ') :', { status: 'done', summary: 'Invitation préparée.', body: [inviteBox(Object.assign({}, c.o, { person: name }), c.d, c.o.start)] });
  }

  // ---------- Importer une capture d'écran (Doctolib, SMS, e-mail de confirmation) ----------
  // La lecture se fait sur le téléphone (Tesseract) : l'image n'est envoyée nulle part.
  var TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = TESS_URL; s.async = true;
      s.onload = function () { window.Tesseract ? res(window.Tesseract) : rej(new Error('tesseract')); };
      s.onerror = rej; document.head.appendChild(s);
    });
  }
  function ocrImage(file, onProgress) {
    return loadTesseract().then(function (T) {
      return T.recognize(file, 'fra', { logger: function (m) { if (m.status === 'recognizing text' && onProgress) onProgress(Math.round(m.progress * 100)); } });
    }).then(function (r) { return (r && r.data && r.data.text) || ''; });
  }
  var MONTHS_FR = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
  var SPECIALTIES = ['chirurgien-dentiste', 'orthodontiste', 'dentiste', 'medecin generaliste', 'generaliste', 'kinesitherapeute', 'masseur-kinesitherapeute', 'kine', 'osteopathe', 'ophtalmologue', 'orthoptiste',
    'dermatologue', 'gynecologue', 'sage-femme', 'pediatre', 'cardiologue', 'orl', 'psychologue', 'psychiatre', 'radiologie', 'radiologue', 'laboratoire', 'podologue', 'pedicure', 'dieteticien', 'infirmier', 'veterinaire', 'coiffeur', 'coiffure', 'barbier', 'esthetique', 'garage', 'controle technique'];
  function guessYear(mo, day) {
    var now = new Date(), y = now.getFullYear();
    var cand = new Date(y, mo - 1, day);
    if (cand < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)) y++;
    return y;
  }
  function parseAppointmentText(raw) {
    var txt = (raw || '').replace(/\r/g, '');
    var lines = txt.split('\n').map(function (s) { return s.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var n = norm(txt).replace(/’/g, "'");
    var r = { title: '', date: '', start: '', address: '', phone: '', source: /doctolib/i.test(txt) ? 'Doctolib' : '', who: '', spec: '' };
    // Date : « lundi 24 novembre 2026 », « 24 nov. », « 24/11/2026 »
    var m = n.match(/\b(\d{1,2})(?:er)?\s+(janv(?:ier)?|fevr?(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|aout|sept?(?:embre)?|oct(?:obre)?|nov(?:embre)?|dec(?:embre)?)\.?(?:\s+(\d{4}))?/);
    if (m) {
      var mo = MONTHS_FR.findIndex(function (x) { return x.indexOf(m[2].slice(0, 3)) === 0; }) + 1;
      if (mo > 0) r.date = (m[3] || guessYear(mo, +m[1])) + '-' + pad(mo) + '-' + pad(+m[1]);
    }
    if (!r.date) {
      m = n.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/);
      if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
        var yy = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : guessYear(+m[2], +m[1]);
        r.date = yy + '-' + pad(+m[2]) + '-' + pad(+m[1]);
      }
    }
    if (!r.date && /\bdemain\b/.test(n)) r.date = addDays(today(), 1);
    if (!r.date && /aujourd'hui/.test(n)) r.date = today();
    // Heure : « à 09:30 », « 9h30 », « 14 h 15 »
    m = n.match(/\b(?:a|à)\s*(\d{1,2})\s*[h:]\s*(\d{2})?\b/) || n.match(/\b(\d{1,2})\s*[h:]\s*(\d{2})\b/) || n.match(/\b(\d{1,2})\s*h\b/);
    if (m && +m[1] < 24) r.start = pad(+m[1]) + ':' + (m[2] || '00');
    // Téléphone
    m = txt.match(/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/); if (m) r.phone = m[0];
    // Adresse : la ligne avec un code postal (et la ligne de rue juste avant)
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (/\b\d{5}\b/.test(L) && !/(?:\+33|0)[1-9](?:[\s.-]?\d{2}){4}/.test(L)) {
        var prev = lines[i - 1] || '';
        r.address = (/^\d+\s*(bis|ter)?\s*,?\s*\w/i.test(L) || !/\d+[\s,]+(rue|av|avenue|bd|boulevard|place|chemin|allee|allée|quai|cours|impasse|route)/i.test(prev) ? '' : prev + ', ') + L;
        if (!/\d+[\s,]+(rue|av|avenue|bd|boulevard|place|chemin|allée|allee|quai|cours|impasse|route)/i.test(r.address) && /\d+[\s,]+(rue|av|avenue|bd|boulevard|place|chemin|allée|allee|quai|cours|impasse|route)/i.test(prev)) r.address = prev + ', ' + L;
        break;
      }
    }
    // Praticien et spécialité
    m = txt.match(/\b(?:Dr\.?|Docteur|Pr\.?|Professeur|Ma[iî]tre|Me)\s+([A-ZÉÈ][A-Za-zÀ-ÿ'-]+(?:\s+[A-ZÉÈ][A-Za-zÀ-ÿ'-]+)?)/);
    if (m) r.who = m[0].replace(/\s+/g, ' ').trim();
    var spec = SPECIALTIES.filter(function (s) { return n.indexOf(s) >= 0; })[0];
    if (spec) r.spec = cap(spec.replace('medecin generaliste', 'médecin généraliste').replace('generaliste', 'médecin généraliste').replace('kinesitherapeute', 'kinésithérapeute').replace('masseur-kinésithérapeute', 'kinésithérapeute').replace('osteopathe', 'ostéopathe').replace('pediatre', 'pédiatre').replace('gynecologue', 'gynécologue').replace('veterinaire', 'vétérinaire').replace('esthetique', 'esthéticienne'));
    r.title = r.spec && r.who ? r.spec + ' · ' + r.who : (r.who || r.spec || '');
    if (!r.title) {
      var first = lines.filter(function (l) { return l.length > 3 && !/\d{2}[:h]\d{2}|\b\d{5}\b|rendez-vous confirm/i.test(l); })[0];
      r.title = first ? first.slice(0, 50) : 'Rendez-vous';
    }
    return r;
  }
  function aiScreenshot(file) {
    if (!file) return;
    aiOpen();
    aiThread.push({ id: ++aiMsgId, role: 'user', text: 'Capture d\'écran : ' + (file.name || 'image') });
    var prog = el('p', { class: 'hint', text: 'Préparation de la lecture… (la première fois, l\'outil se télécharge : quelques secondes)' });
    aiSay('Je lis ta capture. Elle reste sur ton téléphone : rien n\'est envoyé.', { status: 'done', summary: 'Lecture d\'une capture.', body: [prog] });
    ocrImage(file, function (p) { prog.textContent = 'Lecture en cours : ' + p + ' %'; }).then(function (text) {
      prog.textContent = 'Lecture terminée.';
      if (!text.trim()) return aiSay('Je n\'ai trouvé aucun texte sur cette image. Essaie avec une capture plus nette.');
      aiShotResult(parseAppointmentText(text), text);
    }).catch(function () {
      prog.textContent = 'Lecture impossible.';
      aiSay('Je n\'ai pas réussi à lire cette capture (pas de connexion pour télécharger l\'outil de lecture ?). Réessaie, ou ajoute le rendez-vous avec l\'ajout rapide.');
    });
  }
  function aiShotResult(r, rawText) {
    var fTitle = el('input', { value: r.title, 'aria-label': 'Titre' });
    var fDate = el('input', { type: 'date', value: r.date, 'aria-label': 'Date' });
    var fTime = el('input', { type: 'time', value: r.start, 'aria-label': 'Heure' });
    var fAddr = el('input', { value: r.address, placeholder: 'Adresse (à compléter si besoin)', 'aria-label': 'Adresse' });
    var fPhone = el('input', { type: 'tel', value: r.phone, placeholder: 'Téléphone (facultatif)', 'aria-label': 'Téléphone' });
    var missing = [!r.date && 'la date', !r.start && 'l\'heure', !r.address && 'l\'adresse'].filter(Boolean);
    var form = el('div', { class: 'stack shot-form' },
      el('label', { text: 'Rendez-vous' }), fTitle,
      el('div', { class: 'grid2' }, el('div', null, el('label', { text: 'Date' }), fDate), el('div', null, el('label', { text: 'Heure' }), fTime)),
      el('label', { text: 'Adresse' }), fAddr,
      el('label', { text: 'Téléphone' }), fPhone,
      aiBtn('Ajouter à mon planning', function (e) {
        if (!fDate.value || !fTime.value) { toast('Indique la date et l\'heure.'); (fDate.value ? fTime : fDate).focus(); return; }
        var item = { id: uid(), title: fTitle.value.trim() || 'Rendez-vous', fixed: true, date: fDate.value, start: fTime.value, deadline: '', after: '',
          duration: /dentiste|kine|osteo|coiff/i.test(norm(fTitle.value)) ? 45 : 30, priority: 'normale', repeat: 'none', skip: [], doneDates: {},
          locationText: fAddr.value.trim(), place: null, online: false, source: r.source || 'capture', phone: fPhone.value.trim(), notes: '' };
        withUndo('Rendez-vous ajouté', function () { state.items.push(item); save(); render(); });
        e.currentTarget.disabled = true;
        var after = function () {
          var it = byId(item.id);
          var o = it ? planDay(it.date).out.filter(function (x) { return x.item.id === it.id; })[0] : null;
          aiSay('C\'est ajouté : ' + item.title + ', ' + aiDayName(item.date) + ' à ' + item.start + (it && it.place ? ', ' + it.place.label : '') + '.' +
            (o && o.travel ? ' Départ conseillé à ' + fmt(o.leaveAt || o.start - o.travel) + '.' : '') +
            (r.source === 'Doctolib' ? ' Pour l\'annuler ou le déplacer, passe toujours par Doctolib.' : ''),
            { status: 'done', summary: 'Rendez-vous importé.', body: [aiBtn('Voir la journée', function () { $('#ai').close(); currentDate = item.date; go('day'); setMode('day'); }, 'block')] });
        };
        if (item.locationText) findAddress(item.id).then(after); else after();
      }, 'primary block'),
      el('details', { class: 'more' }, el('summary', null, 'Texte lu'), el('pre', { class: 'ocr-raw', text: rawText.slice(0, 1500) })));
    aiSay(missing.length ? 'Voici ce que j\'ai lu. Il me manque ' + missing.join(', ') + ' : complète avant d\'ajouter.' : 'Voici ce que j\'ai lu. Vérifie, puis ajoute :', { status: 'done', summary: 'Capture lue.', body: [form] });
  }

  $('#aiShot').addEventListener('click', function () { $('#shotFile').click(); });
  $('#shotFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (f) aiScreenshot(f);
  });

  // ================= Premier lancement guidé =================
  var onb = { step: 0, home: null, work: null, workKind: 'Travail', addHours: true, wStart: '09:00', wEnd: '18:00', mode: 'transit' };
  var ONB_MODES = [
    ['transit', 'Transports', '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M8 21l2-4M16 21l-2-4"/><circle cx="8.5" cy="14" r=".5"/><circle cx="15.5" cy="14" r=".5"/>'],
    ['walking', 'À pied', '<circle cx="13" cy="4" r="2"/><path d="M10 22l2-7-3-3 1-5 4 3 3 1M9 12l-2 4"/>'],
    ['bicycling', 'Vélo', '<circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17l4-8h5l3 8M10 9l2 8M14 5h3"/>'],
    ['driving', 'Voiture', '<path d="M5 16V11l2-5h10l2 5v5M3 16h18v3H3zM5 11h14"/><circle cx="7.5" cy="16" r="1"/><circle cx="16.5" cy="16" r="1"/>']
  ];
  function openOnboarding() {
    onb = { step: 0, home: state.settings.home || null, work: findFav('Travail') || findFav('École') || null, gym: findFav('Sport') || null, workKind: findFav('Travail') || !findFav('École') ? 'Travail' : 'École', addHours: !state.items.some(function (i) { return i.repeat !== 'none'; }), wStart: '09:00', wEnd: '18:00', mode: state.settings.mode || 'transit' };
    renderOnb();
    var dl = $('#onb');
    if (!dl.open) { if (dl.showModal) dl.showModal(); else dl.setAttribute('open', ''); }
  }
  $('#onbAgain').addEventListener('click', openOnboarding);
  $('#onb').addEventListener('cancel', function () { finishOnb(true); });

  function onbSearch(placeholder, onPick) {
    var input = el('input', { placeholder: placeholder, 'aria-label': placeholder });
    var btn = el('button', { type: 'button', class: 'btn' }, 'Chercher');
    var results = el('div', { class: 'results' });
    setupSearch(input, btn, results, onPick);
    return el('div', { class: 'stack' }, el('div', { class: 'searchrow' }, input, btn), results);
  }
  function renderOnb() {
    var body = $('#onbBody'); body.innerHTML = '';
    var prog = $('#onbProgress'); prog.innerHTML = '';
    for (var i = 0; i < 3; i++) prog.appendChild(el('span', { class: i < onb.step ? 'on' : '' }));
    var next = function () { onb.step++; renderOnb(); };

    if (onb.step === 0) {
      $('#onbStep').textContent = 'Bienvenue';
      $('#onbTitle').textContent = 'Ton GPS du quotidien';
      body.appendChild(el('p', { class: 'onb-lead', text: 'Tu notes ce que tu as à faire, Ma Journée trouve les lieux, choisit le meilleur ordre, calcule les trajets et t\'aide quand tout dérape. 3 questions pour commencer (30 secondes).' }));
      body.appendChild(el('p', { class: 'privacy', text: 'Tout reste sur ton téléphone. Pas de compte à créer.' }));
      body.appendChild(el('div', { class: 'onb-nav' }, aiBtn('Passer', function () { finishOnb(true); }), aiBtn('C\'est parti', next, 'primary')));
      return;
    }
    if (onb.step === 1) {
      $('#onbStep').textContent = 'Question 1 sur 3';
      $('#onbTitle').textContent = 'D\'où pars-tu le matin ?';
      body.appendChild(el('p', { class: 'onb-lead', text: 'Ton adresse sert à calculer les trajets et à trouver les lieux près de chez toi. Elle reste sur ton téléphone.' }));
      if (onb.home) body.appendChild(el('p', { class: 'picked', text: 'Départ : ' + onb.home.label }));
      body.appendChild(onbSearch(onb.home ? 'Changer d\'adresse' : 'Ton adresse (rue, ville)', function (p) { onb.home = p; renderOnb(); }));
      body.appendChild(el('div', { class: 'onb-nav' }, aiBtn('Plus tard', next), el('button', { type: 'button', class: 'btn primary', disabled: onb.home ? null : 'disabled', onclick: next }, 'Continuer')));
      return;
    }
    if (onb.step === 2) {
      $('#onbStep').textContent = 'Question 2 sur 3';
      $('#onbTitle').textContent = 'Tu travailles ou tu étudies où ?';
      var kinds = el('div', { class: 'chips' });
      ['Travail', 'École'].forEach(function (k) {
        kinds.appendChild(el('button', { type: 'button', class: 'chip', 'aria-pressed': onb.workKind === k ? 'true' : 'false', onclick: function () { onb.workKind = k; renderOnb(); } }, k === 'École' ? 'École / études' : 'Travail'));
      });
      body.appendChild(kinds);
      if (onb.work) body.appendChild(el('p', { class: 'picked', text: onb.workKind + ' : ' + onb.work.label }));
      body.appendChild(onbSearch(onb.work ? 'Changer d\'adresse' : 'Adresse de ton ' + (onb.workKind === 'École' ? 'école' : 'travail'), function (p) { onb.work = p; renderOnb(); }));
      if (onb.work) {
        var cb = el('input', { type: 'checkbox', id: 'onbHours' }); cb.checked = onb.addHours;
        cb.addEventListener('change', function () { onb.addHours = cb.checked; });
        var s1 = el('input', { type: 'time', id: 'onbStart', value: onb.wStart, 'aria-label': 'Heure d\'arrivée' });
        var s2 = el('input', { type: 'time', id: 'onbEnd', value: onb.wEnd, 'aria-label': 'Heure de fin' });
        s1.addEventListener('change', function () { onb.wStart = s1.value; });
        s2.addEventListener('change', function () { onb.wEnd = s2.value; });
        body.appendChild(el('label', { class: 'check', for: 'onbHours' }, cb, ' Ajouter mes horaires au planning, du lundi au vendredi'));
        body.appendChild(el('div', { class: 'grid2' }, el('div', null, s1), el('div', null, s2)));
        // Plusieurs lieux de travail (clients, cabinets, agences…)
        (onb.extraWorks || []).forEach(function (w, i) {
          body.appendChild(el('div', { class: 'picked onb-extra' }, el('span', { text: w.name + ' : ' + w.place.label }),
            el('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Retirer ' + w.name, onclick: function () { onb.extraWorks.splice(i, 1); renderOnb(); } }, '×')));
        });
        if (onb.addingWork) {
          var wn = el('input', { id: 'onbWorkName', placeholder: 'Nom (ex. Client Dupont, Cabinet 2)', 'aria-label': 'Nom de ce lieu de travail' });
          body.appendChild(wn);
          body.appendChild(onbSearch('Entreprise ou adresse', function (p) {
            onb.extraWorks = onb.extraWorks || [];
            onb.extraWorks.push({ name: wn.value.trim() || ('Travail ' + (onb.extraWorks.length + 2)), place: p });
            onb.addingWork = false; renderOnb();
          }));
        } else {
          body.appendChild(el('button', { type: 'button', class: 'link-btn', style: 'align-self:flex-start', onclick: function () { onb.addingWork = true; renderOnb(); var i = $('#onbWorkName'); if (i) i.focus(); } }, '+ J\'ai plusieurs lieux de travail'));
        }
      }
      body.appendChild(el('p', { class: 'sectlabel', text: 'Et ta salle de sport ? (facultatif)' }));
      if (onb.gym) body.appendChild(el('p', { class: 'picked', text: 'Salle de sport : ' + onb.gym.label }));
      body.appendChild(onbSearch(onb.gym ? 'Changer de salle' : 'Nom ou adresse de ta salle, piscine, club…', function (p) { onb.gym = p; renderOnb(); }));
      body.appendChild(el('div', { class: 'onb-nav' },
        aiBtn(onb.work || onb.gym ? 'Plus tard' : 'Pas de lieu fixe', function () { if (!onb.work && !onb.gym) { onb.work = null; } next(); }),
        el('button', { type: 'button', class: 'btn primary', disabled: onb.work || onb.gym ? null : 'disabled', onclick: next }, 'Continuer')));
      return;
    }
    if (onb.step === 3) {
      $('#onbStep').textContent = 'Question 3 sur 3';
      $('#onbTitle').textContent = 'Tu te déplaces surtout comment ?';
      var grid = el('div', { class: 'onb-choices' });
      ONB_MODES.forEach(function (m) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = m[2];
        grid.appendChild(el('button', { type: 'button', class: 'onb-choice', 'aria-pressed': onb.mode === m[0] ? 'true' : 'false', onclick: function () { onb.mode = m[0]; renderOnb(); } }, svg, m[1]));
      });
      body.appendChild(grid);
      body.appendChild(el('div', { class: 'onb-nav' }, el('button', { type: 'button', class: 'btn primary', onclick: function () { finishOnb(false); } }, 'Terminer')));
      return;
    }
    // Écran final
    $('#onbStep').textContent = 'C\'est prêt';
    $('#onbTitle').textContent = 'Ta journée t\'attend';
    body.appendChild(el('p', { class: 'onb-lead', text: 'Écris tes tâches comme tu les dirais (« pharmacie, courses, dentiste à 15h ») ou demande à l\'assistant. Glisse une étape vers la droite pour la terminer, vers la gauche pour la déplacer.' }));
    body.appendChild(aiBtn('Essayer l\'assistant ✨', function () { $('#onb').close(); aiOpen(); }, 'primary block'));
    if (!state.items.length) body.appendChild(aiBtn('Voir un exemple', function () { $('#onb').close(); loadDemo(); }, 'block'));
    body.appendChild(aiBtn('Commencer', function () { $('#onb').close(); }, 'block'));
  }
  function finishOnb(skipped) {
    state.settings.onboarded = true;
    if (!state.settings.firstUse) state.settings.firstUse = today();
    if (!skipped) {
      if (onb.home) state.settings.home = onb.home;
      state.settings.mode = onb.mode;
      if (onb.gym) {
        state.favorites = state.favorites.filter(function (f) { return norm(f.name) !== 'sport'; });
        state.favorites.push({ id: uid(), name: 'Sport', label: onb.gym.label, lat: onb.gym.lat, lon: onb.gym.lon });
      }
      if (onb.work) {
        var name = onb.workKind;
        state.favorites = state.favorites.filter(function (f) { return norm(f.name) !== norm(name); });
        state.favorites.push({ id: uid(), name: name, label: onb.work.label, lat: onb.work.lat, lon: onb.work.lon, kind: name === 'Travail' ? 'work' : undefined });
        (onb.extraWorks || []).forEach(function (w) {
          state.favorites = state.favorites.filter(function (f) { return norm(f.name) !== norm(w.name); });
          state.favorites.push({ id: uid(), name: w.name, label: w.place.label, lat: w.place.lat, lon: w.place.lon, kind: 'work' });
        });
        var hasRoutine = state.items.some(function (i) { return i.repeat !== 'none' && norm(i.title) === norm(name); });
        if (onb.addHours && onb.wStart && onb.wEnd && toMin(onb.wEnd) > toMin(onb.wStart) && !hasRoutine) {
          state.items.push({ id: uid(), title: name, fixed: true, date: today(), start: onb.wStart, deadline: '', duration: toMin(onb.wEnd) - toMin(onb.wStart),
            priority: 'normale', repeat: 'weekdays', skip: [], doneDates: {}, locationText: '', place: { name: name, label: onb.work.label, lat: onb.work.lat, lon: onb.work.lon }, online: false, source: 'manuel' });
        }
      }
    }
    save(); render(); loadWeather(true);
    if (skipped) { var dl = $('#onb'); if (dl.open) dl.close(); return; }
    onb.step = 4; renderOnb();
  }

  // ================= Donner mon avis =================
  var FEEDBACK_EMAIL = ''; // adresse qui reçoit les avis (à renseigner)
  var fb = {};
  function openFeedback() {
    fb = { rating: 0, useful: '', annoying: '', missing: '', price: '', sent: false };
    renderFb();
    var dl = $('#fb');
    if (!dl.open) { if (dl.showModal) dl.showModal(); else dl.setAttribute('open', ''); }
  }
  $('#fbBtn').addEventListener('click', openFeedback);
  $('#fbClose').addEventListener('click', function () { $('#fb').close(); });
  function fbText() {
    return 'Avis sur Ma Journée\n\nNote : ' + (fb.rating ? fb.rating + '/5' : 'non donnée') +
      '\nLe plus utile : ' + (fb.useful || '-') + '\nCe qui m\'a perdu ou agacé : ' + (fb.annoying || '-') +
      '\nCe qui manque : ' + (fb.missing || '-') + '\nJe paierais par mois : ' + (fb.price || '-') +
      '\n\n(utilisée depuis le ' + frDate(state.settings.firstUse || today(), { day: 'numeric', month: 'long' }) + ')';
  }
  function renderFb() {
    var body = $('#fbBody'); body.innerHTML = '';
    if (fb.sent) {
      $('#fbTitle').textContent = 'Merci !';
      body.appendChild(el('p', { class: 'onb-lead', text: 'Ton avis est prêt. Envoie-le à la personne qui t\'a fait découvrir l\'app : c\'est ce qui nous aide le plus.' }));
      var txt = fbText();
      if (navigator.share) body.appendChild(aiBtn('Envoyer (message, WhatsApp…)', function () { navigator.share({ title: 'Avis Ma Journée', text: txt }).catch(function () { /* annulé */ }); }, 'primary block'));
      if (FEEDBACK_EMAIL) body.appendChild(el('a', { class: 'btn block' + (navigator.share ? '' : ' primary'), href: 'mailto:' + FEEDBACK_EMAIL + '?subject=' + encodeURIComponent('Avis sur Ma Journée') + '&body=' + encodeURIComponent(txt) }, 'Envoyer par e-mail'));
      body.appendChild(aiBtn('Copier le texte', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast('Avis copié'); }, function () { toast('Copie impossible sur cet appareil.'); });
      }, 'block'));
      return;
    }
    $('#fbTitle').textContent = 'Aide-nous à améliorer Ma Journée';
    body.appendChild(el('p', { class: 'sectlabel', text: 'Ta note globale' }));
    var stars = el('div', { class: 'stars', role: 'group', 'aria-label': 'Note sur 5' });
    [1, 2, 3, 4, 5].forEach(function (n) { stars.appendChild(el('button', { type: 'button', 'aria-pressed': fb.rating === n ? 'true' : 'false', 'aria-label': n + ' sur 5', onclick: function () { fb.rating = n; renderFb(); } }, String(n))); });
    body.appendChild(stars);
    function area(key, id, label, ph) {
      var t = el('textarea', { id: id, placeholder: ph }); t.value = fb[key];
      t.addEventListener('input', function () { fb[key] = t.value; });
      body.appendChild(el('label', { for: id, text: label })); body.appendChild(t);
    }
    area('useful', 'fbUseful', 'Qu\'est-ce qui t\'a été le plus utile ?', 'Ex. le SOS, la pharmacie sur le trajet…');
    area('annoying', 'fbAnnoy', 'Qu\'est-ce qui t\'a perdu ou agacé ?', 'Ex. je n\'ai pas trouvé comment…');
    area('missing', 'fbMissing', 'Une fonction qui te manque ?', 'Ex. partager avec ma famille…');
    body.appendChild(el('p', { class: 'sectlabel', text: 'Pour la version Pro (assistant IA, agendas connectés…), tu paierais par mois :' }));
    var prices = el('div', { class: 'chips' });
    ['Rien', '1 à 2 €', '3 à 5 €', 'Plus de 5 €'].forEach(function (p) {
      prices.appendChild(el('button', { type: 'button', class: 'chip', 'aria-pressed': fb.price === p ? 'true' : 'false', onclick: function () { fb.price = p; renderFb(); } }, p));
    });
    body.appendChild(prices);
    body.appendChild(aiBtn('Valider mon avis', function () {
      state.feedback = (state.feedback || []).concat([{ at: today(), rating: fb.rating, useful: fb.useful, annoying: fb.annoying, missing: fb.missing, price: fb.price }]);
      state.settings.feedbackDone = today();
      save(); render();
      fb.sent = true; renderFb();
    }, 'primary block'));
  }
  // Relance au bout de 7 jours d'utilisation
  function feedbackNudge(container) {
    var s = state.settings;
    if (!s.firstUse || s.feedbackDone || (s.feedbackLater && s.feedbackLater > today())) return;
    if (today() < addDays(s.firstUse, 7) || !state.items.length) return;
    container.appendChild(el('div', { class: 'tip' },
      el('p', { text: 'Ça fait une semaine que tu utilises Ma Journée ! 3 questions pour l\'améliorer ?' }),
      el('button', { type: 'button', onclick: function () { s.feedbackLater = addDays(today(), 7); save(); render(); } }, 'Plus tard'),
      el('button', { type: 'button', onclick: openFeedback }, 'Répondre')));
  }

  // ================= Météo (Open-Meteo, gratuit, sans compte) =================
  var wx = { data: null, at: 0, key: '' }, wxLoading = false;
  function loadWeather(force) {
    var h = state.settings.home;
    if (!h || wxLoading) return;
    var key = h.lat.toFixed(2) + ',' + h.lon.toFixed(2);
    if (!force && wx.data && wx.key === key && Date.now() - wx.at < 2 * 3600e3) return;
    if (!wx.data) { try { var c = JSON.parse(localStorage.getItem('mj.weather')); if (c && c.key === key && Date.now() - c.at < 2 * 3600e3) { wx = c; render(); return; } } catch (e) { /* ignore */ } }
    wxLoading = true;
    fetch('https://api.open-meteo.com/v1/forecast?latitude=' + h.lat + '&longitude=' + h.lon +
      '&hourly=temperature_2m,precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max&timezone=Europe%2FParis&forecast_days=8')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.hourly) return;
        wx = { data: j, at: Date.now(), key: key };
        try { localStorage.setItem('mj.weather', JSON.stringify(wx)); } catch (e) { /* ignore */ }
        render();
      }).catch(function () { /* hors ligne : pas de météo */ }).then(function () { wxLoading = false; });
  }
  function wxAt(date, min) {
    var j = wx.data; if (!j || !j.hourly) return null;
    var i = j.hourly.time.indexOf(date + 'T' + pad(Math.max(0, Math.min(23, Math.floor(min / 60)))) + ':00');
    if (i < 0) return null;
    return { t: Math.round(j.hourly.temperature_2m[i]), p: j.hourly.precipitation_probability[i] || 0, c: j.hourly.weather_code[i] };
  }
  function wxDay(date) {
    var j = wx.data; if (!j || !j.daily) return null;
    var i = j.daily.time.indexOf(date); if (i < 0) return null;
    return { max: Math.round(j.daily.temperature_2m_max[i]), min: Math.round(j.daily.temperature_2m_min[i]), c: j.daily.weather_code[i], p: j.daily.precipitation_probability_max[i] || 0 };
  }
  function wxLabel(c) {
    if (c === 0) return 'Grand soleil';
    if (c <= 2) return 'Éclaircies';
    if (c === 3) return 'Nuageux';
    if (c === 45 || c === 48) return 'Brouillard';
    if (c >= 51 && c <= 57) return 'Bruine';
    if (c >= 61 && c <= 67) return 'Pluie';
    if (c >= 71 && c <= 77) return 'Neige';
    if (c >= 80 && c <= 82) return 'Averses';
    if (c >= 85 && c <= 86) return 'Averses de neige';
    if (c >= 95) return 'Orage';
    return 'Variable';
  }
  function isWet(w) { return w && (w.p >= 50 || (w.c >= 51 && w.c <= 99 && w.p >= 30)); }
  // Première heure de pluie probable dans la journée (entre 7 h et 22 h)
  function rainFrom(date, fromMin) {
    for (var m = Math.max(fromMin || 0, 7 * 60); m <= 22 * 60; m += 60) { var w = wxAt(date, m); if (isWet(w)) return { at: Math.floor(m / 60) * 60, w: w }; }
    return null;
  }
  function wxSummary(date) {
    var d = wxDay(date); if (!d) return '';
    var rain = rainFrom(date, date === today() ? nowMin() : 0);
    var rainyDay = d.c >= 51 || d.p >= 40;
    return wxLabel(d.c) + ', ' + d.min + '° → ' + d.max + '°' +
      (rain ? ' · pluie probable vers ' + fmt(rain.at) + ' (' + rain.w.p + ' %)' : (rainyDay ? ' · averses possibles dans la journée' : ' · pas de pluie prévue'));
  }
  function rainyDay(date) { var d = wxDay(date); return !!d && (d.c >= 51 || d.p >= 40); }

  // ================= Briefing du matin, bilan du soir, tâches en retard =================
  function renderBrief(plan) {
    var box = $('#brief'); if (!box) return;
    box.innerHTML = '';
    if (currentDate !== today()) return;
    var s = state.settings, t = today(), n = nowMin();
    // 1. Tâches des jours précédents pas faites
    var overdue = state.items.filter(function (i) { return i.repeat === 'none' && !isFixed(i) && i.date < t && !i.doneDates[i.date]; });
    if (overdue.length && s.carryHide !== t) {
      box.appendChild(el('div', { class: 'brief warnb' },
        el('p', { class: 'brief-k', text: 'Pas encore fait' }),
        el('strong', { text: overdue.length + ' tâche' + (overdue.length > 1 ? 's' : '') + ' des jours précédents : ' + overdue.slice(0, 4).map(function (i) { return i.title; }).join(', ') + (overdue.length > 4 ? '…' : '') }),
        el('div', { class: 'btns' },
          aiBtn('Les mettre aujourd\'hui', function () {
            withUndo(overdue.length + ' tâche(s) ajoutée(s) à aujourd\'hui', function () { overdue.forEach(function (i) { i.date = t; }); save(); render(); });
          }, 'primary'),
          aiBtn('Plus tard', function () { s.carryHide = t; save(); render(); }))));
    }
    // 2. Briefing du matin (jusqu'à midi)
    var steps = plan.out.filter(function (o) { return !o.past && !o.item.done && !o.ongoing; });
    if (n < 12 * 60 && s.briefDay !== t && (steps.length || wxDay(t))) {
      var first = steps.filter(function (o) { return o.travel; })[0] || steps[0];
      var lines = [];
      if (steps.length) lines.push(steps.length + ' étape' + (steps.length > 1 ? 's' : '') + ', de ' + fmt(steps[0].start) + ' à ' + fmt(plan.finish) + (plan.totalTravel ? ' · ≈ ' + dur(plan.totalTravel) + ' de trajet' : ''));
      if (first && first.travel) lines.push('Premier départ à ' + fmt(first.leaveAt || first.start - first.travel) + ' pour ' + first.item.title);
      var ws = wxSummary(t); if (ws) lines.push(ws);
      var rain = rainFrom(t, n);
      if (rain && s.mode === 'bicycling') lines.push('Pluie prévue : pense aux transports plutôt qu\'au vélo');
      var takeFrom = steps.filter(function (o) { var src = byId(o.item.id); return src && packList(src).length; })[0];
      if (takeFrom) { var src = byId(takeFrom.item.id); var tk = packList(src).filter(function (x) { return !packChecked(src, t)[x]; }); if (rain) tk.push('Parapluie'); if (tk.length) lines.push('À prendre : ' + tk.join(', ')); }
      else if (rain) lines.push('À prendre : parapluie');
      if (plan.leftover.length) lines.push('Attention : ' + plan.leftover.length + ' tâche(s) ne rentrent pas, regarde les compromis plus bas');
      var ul = el('ul'); lines.forEach(function (l) { ul.appendChild(el('li', { text: l })); });
      box.appendChild(el('div', { class: 'brief' },
        el('p', { class: 'brief-k', text: 'Briefing du matin' }),
        el('strong', { text: 'Bonjour' + (s.name ? ' ' + s.name : '') + ' ! Voici ta journée' }),
        ul,
        aiBtn('C\'est noté', function () { s.briefDay = t; save(); render(); })));
    }
    // 3. Bilan du soir
    var eveningFrom = Math.min(19 * 60, toMin(s.dayEnd) - 60);
    if (n >= eveningFrom && s.recapDay !== t) {
      var occ = occurrences(t);
      if (occ.length) {
        var done = occ.filter(function (o) { return o.done; }).length;
        var left = occ.filter(function (o) { return !o.done && o.repeat === 'none' && !isFixed(o); });
        var all = left.length === 0;
        box.appendChild(el('div', { class: 'brief ' + (all ? 'okb' : '') },
          el('p', { class: 'brief-k', text: 'Bilan du jour' }),
          el('strong', { text: all ? 'Bravo, ta journée est bouclée ! (' + done + ' étape' + (done > 1 ? 's' : '') + ' faite' + (done > 1 ? 's' : '') + ')' : done + ' sur ' + occ.length + ' faites. Reste : ' + left.map(function (i) { return i.title; }).join(', ') }),
          dayGain(t) >= 5 ? el('p', { class: 'brief-w', text: 'L\'ordre optimisé t\'a fait gagner ≈ ' + dur(dayGain(t)) + ' de trajet aujourd\'hui.' }) : null,
          streakDays() >= 2 ? el('p', { class: 'brief-w', text: 'Série : ' + streakDays() + ' jours bouclés d\'affilée.' }) : null,
          wxDay(addDays(t, 1)) ? el('p', { class: 'brief-w', text: 'Demain : ' + wxSummary(addDays(t, 1)) }) : null,
          el('div', { class: 'btns' },
            all ? null : aiBtn('Tout mettre à demain', function () {
              withUndo(left.length + ' tâche(s) mise(s) à demain', function () { left.forEach(function (o) { moveOccurrence(o.id, t, { date: addDays(t, 1) }); }); });
              s.recapDay = t; save(); render();
            }, 'primary'),
            aiBtn(all ? 'Merci !' : 'Je m\'en occupe ce soir', function () { s.recapDay = t; save(); render(); }))));
      }
    }
  }

  // ================= Démarrage =================
  if (!state.settings.firstUse) { state.settings.firstUse = today(); save(); }
  if (!state.settings.onboarded && state.settings.home) { state.settings.onboarded = true; save(); } // utilisateurs déjà installés
  resetForm();
  render();
  applyAccent();
  // Invitation reçue par lien : on l'affiche d'abord ; un nouvel utilisateur voit ensuite la présentation
  var hadInvite = checkInvite();
  if (!state.settings.onboarded) {
    if (hadInvite) {
      var afterInvite = function () { $('#weekDlg').removeEventListener('close', afterInvite); setTimeout(openOnboarding, 250); };
      $('#weekDlg').addEventListener('close', afterInvite);
    } else setTimeout(openOnboarding, 400);
  }
  loadWeather();
  setInterval(function () { loadWeather(); }, 30 * 60 * 1000);
  setInterval(function () {
    checkReminders();
    if ($('#view-day').classList.contains('active') && viewMode === 'day' && currentDate === today()) render();
  }, 60 * 1000);
  setTimeout(checkReminders, 2000);
})();
