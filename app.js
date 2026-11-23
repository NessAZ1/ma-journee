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
  function fmt(m) { m = Math.round(m); return pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60); }
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

  function planDay(date) {
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

    fixed.concat([null]).forEach(function (f) {
      var limit = f ? toMin(f.start) - marginInfo(f).m : end;
      var fPlace = f ? placeOf(f) : null;
      for (;;) {
        var best = null;
        flex.forEach(function (t) {
          var tp = placeOf(t);
          var tt = travel(pos, tp);
          var arrive = cur + tt + (tt ? buffer : 0);
          var finish = arrive + (+t.duration || 15);
          var next = f ? travel(tp || pos, fPlace) : 0;
          if (finish + next + (next ? buffer : 0) > limit) return;
          if (t.deadline && finish > toMin(t.deadline)) return;
          var score = tt;
          if (t.priority === 'haute') score -= 60;
          if (t.deadline) score -= Math.max(0, 180 - (toMin(t.deadline) - cur)) / 2;
          if (!best || score < best.score) best = { t: t, tt: tt, arrive: arrive, finish: finish, score: score };
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
    { re: /\b(courses|supermarche|epicerie|marche)\b/, list: ['Sacs', 'Liste de courses'] },
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
      list.forEach(function (c) { c._d = detourKm(pts, c); });
      list.sort(function (a, b) { return a._d - b._d; });
      var pick = list[0];
      var closest = list.slice().sort(function (a, b) { return km(h, a) - km(h, b); })[0];
      pick.detour = kmMin(pick._d) <= 2 ? 0 : kmMin(pick._d);
      if (closest !== pick) pick.closestDetour = kmMin(closest._d);
      list.forEach(function (c) { delete c._d; });
      return pick;
    }
    return nominatim('limit=40&bounded=1&q=' + encodeURIComponent(q) + box).then(function (l) {
      if (l.length) return best(l);
      return nominatim('limit=20&bounded=1&q=' + encodeURIComponent(q) + viewbox(h, 0.1, 0.07)).then(best);
    });
  }
  function onRouteToast(pl) {
    if (!pl) return;
    var t = 'Trouvé : ' + pl.name + (pl.detour ? ' · +' + pl.detour + ' min de détour' : ' · pile sur votre trajet');
    if (pl.closestDetour && pl.closestDetour > (pl.detour || 0) + 2) t += ' (le plus proche de chez vous : +' + pl.closestDetour + ' min)';
    toast(t);
  }

  function setupSearch(input, btn, results, onPick) {
    function run() {
      var q = input.value.trim();
      if (!q) { input.focus(); return; }
      results.innerHTML = '';
      results.appendChild(el('p', { class: 'hint', text: 'Recherche en cours…' }));
      geocode(q).then(function (list) {
        results.innerHTML = '';
        if (!list.length) { results.appendChild(el('p', { class: 'hint', text: 'Aucun résultat. Ajoutez la ville ou le nom de la rue.' })); return; }
        var h = state.settings.home;
        list.forEach(function (p) {
          var dist = h ? ' · ' + (km(h, p) < 1 ? Math.round(km(h, p) * 1000) + ' m' : km(h, p).toFixed(1).replace('.', ',') + ' km') : '';
          results.appendChild(el('button', { type: 'button', class: 'result', onclick: function () { results.innerHTML = ''; onPick(p); } },
            el('strong', { text: p.name }), el('small', { text: p.label + dist })));
        });
      }).catch(function () {
        results.innerHTML = '';
        results.appendChild(el('p', { class: 'hint', text: 'Recherche impossible (pas de connexion ?). Le lieu sera enregistré tel quel.' }));
      });
    }
    btn.addEventListener('click', run);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  }

  function findAddress(id, btn) {
    var it = byId(id); if (!it) return Promise.resolve(false);
    if (btn) { btn.disabled = true; btn.textContent = 'Recherche…'; }
    return geocode(it.locationText).then(function (list) {
      if (list.length) { it.place = list[0]; save(); render(); toast('Adresse trouvée : ' + list[0].name); return true; }
      toast('Adresse introuvable. Modifiez le lieu à la main.');
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

  function parseQuick(text) {
    return text.split(/[,;\n]+|\s+(?:et|puis)\s+/i).map(function (s) { return s.trim(); }).filter(Boolean).map(function (chunk) {
      var it = { fixed: false, start: '', deadline: '', duration: 0, priority: 'normale', repeat: 'none', date: currentDate, online: false, place: null, locationText: '', query: '' };
      var t = ' ' + chunk + ' ';
      t = t.replace(/\bavant\s+(\d{1,2})\s*h\s*(\d{2})?/i, function (m, h, mi) { if (+h < 24) { it.deadline = pad(+h) + ':' + (mi || '00'); return ' '; } return m; });
      t = t.replace(/\s(?:à\s*|a\s+)?(\d{1,2})\s*h\s*(\d{2})?(?=\s)/i, function (m, h, mi) { if (+h < 24) { it.start = pad(+h) + ':' + (mi || '00'); it.fixed = true; return ' '; } return m; });
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
      t = t.replace(/\b(demain)\b/i, function () { it.date = addDays(currentDate, 1); return ' '; });
      t = t.replace(/^\s*(je dois|il faut|faut|penser à|ne pas oublier de)\s+/i, ' ');
      t = t.replace(/\s+(à|a|pour|vers)\s*$/i, ' ').replace(/\s+/g, ' ').trim();
      it.title = cap(t || chunk.trim());

      var n = norm(it.title);
      var fav = state.favorites.filter(function (f) { return n.indexOf(norm(f.name)) >= 0; })[0];
      if (!fav && /\b(boulot|bureau|taf|taff)\b/.test(n)) fav = findFav('Travail');
      if (/\b(travail|boulot|bureau|taf|taff)\b/.test(n) && !it.duration) it.duration = 480;
      if (!fav && /\b(ecole|creche|enfants)\b/.test(n)) fav = findFav('École');
      if (fav) { it.place = { name: fav.name, label: fav.label, lat: fav.lat, lon: fav.lon }; }
      var cat = CATS.filter(function (c) { return c.k.some(function (k) { return new RegExp('\\b' + k).test(n); }); })[0];
      if (REMOTE.test(n) && !cat) { it.online = true; if (!it.duration) it.duration = 15; }
      if (cat) { if (!it.duration) it.duration = cat.d; if (!it.place && !it.fixed) it.query = cat.q; }
      if (!it.duration) it.duration = 30;
      return it;
    });
  }

  $('#quickForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = $('#quickInput').value.trim();
    if (!text) { $('#quickInput').focus(); return; }
    var parsed = parseQuick(text);
    var created = parsed.map(function (p) {
      var item = {
        id: uid(), title: p.title, fixed: p.fixed, date: p.date, start: p.start, deadline: p.deadline,
        duration: p.duration, priority: p.priority, repeat: p.repeat, skip: [], doneDates: {},
        locationText: '', place: p.place, online: p.online, source: 'manuel', query: p.query || ''
      };
      state.items.push(item);
      return { item: item, query: p.query };
    });
    save();
    $('#quickInput').value = '';
    render();
    var toFind = created.filter(function (c) { return c.query; });
    var msg = created.length + (created.length > 1 ? ' éléments ajoutés' : ' élément ajouté');
    if (!toFind.length) { toast(msg + ' et organisés.'); return; }
    if (!state.settings.home) {
      toFind.forEach(function (c) { c.item.locationText = c.query; });
      save(); render();
      toast(msg + '. Indiquez votre point de départ pour trouver les lieux proches.');
      return;
    }
    toast(msg + '. Recherche des lieux sur votre trajet…');
    var found = [];
    toFind.reduce(function (p, c) {
      return p.then(function () {
        return geocodeNearest(c.query, c.item.date).then(function (pl) {
          var it = byId(c.item.id); if (!it) return;
          if (pl) { it.place = pl; found.push(pl); } else it.locationText = c.query;
          save(); render();
        }).catch(function () { var it = byId(c.item.id); if (it) { it.locationText = c.query; save(); } });
      });
    }, Promise.resolve()).then(function () {
      render();
      if (found.length === 1) onRouteToast(found[0]);
      else toast(found.length + ' lieux trouvés sur votre trajet, trajets calculés.');
    });
  });

  // ================= Navigation =================
  function go(view) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.dataset.goto === view; t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
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
    var where = it.online ? 'Sans déplacement' : (it.place ? it.place.name : (it.locationText || 'Lieu à préciser'));
    var meta = where + ' · ' + dur(+it.duration || 30) + (it.deadline && !fixed ? ' · avant ' + it.deadline : '') +
      (it.source && it.source !== 'manuel' && it.source !== 'exemple' ? ' · via ' + it.source : '');
    var detourNote = it.place && it.place.detour != null && !it.done
      ? el('p', { class: 'onroute', text: it.place.detour <= 2 ? 'Pile sur votre trajet' : 'Sur votre trajet · +' + it.place.detour + ' min de détour' }) : null;

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
      it.done ? null : packBox(it, d),
      btns);
    var swipe = el('div', { class: 'swipe' },
      el('div', { class: 'swipe-bg', 'aria-hidden': 'true' },
        el('span', { class: 'sw-done', text: it.done ? '↺ Pas fait' : '✓ Terminé' }),
        el('span', { class: 'sw-act', text: 'Reprogrammer · Annuler · Prévenir' })),
      card);
    makeSwipe(swipe, card, function () { markDone(it.id, d); }, function () { openSheet(it.id, d, 'move'); });

    var travelText = null;
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
    var box = el('details', { class: 'pack' + (list.length && nOk === list.length ? ' ok' : '') },
      el('summary', null, list.length ? 'À prendre · ' + nOk + '/' + list.length : '+ Liste « à prendre »'));
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
    var add = el('input', { type: 'text', placeholder: 'Ajouter (ex. clés, parapluie)', 'aria-label': 'Ajouter un objet à prendre' });
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
    var next = plan.out.filter(function (o) { return !o.item.done && !o.past && o.end > n; })[0];
    if (!next) return;
    var leave = next.travel ? (next.leaveAt || next.start - next.travel) : next.start;
    var when = leave <= n ? (next.travel ? 'Partez maintenant' : 'Maintenant') : (next.travel ? 'Partir à ' + fmt(leave) : 'À ' + fmt(next.start));
    var late = lateMinutes(next.item, currentDate);
    if (late) when = 'Retard estimé : ' + late + ' min';
    box.hidden = false;
    box.appendChild(el('div', null,
      el('small', { text: 'Prochaine étape' }),
      el('strong', { text: fmt(next.start) + ' · ' + next.item.title }),
      el('span', { text: when + (next.travel ? ' · ≈ ' + dur(next.travel) + ' de trajet' : '') })));
    var src = byId(next.item.id);
    var toTake = src ? packList(src).filter(function (x) { return !packChecked(src, currentDate)[x]; }) : [];
    if (toTake.length) box.firstChild.appendChild(el('span', { class: 'take', text: 'À prendre : ' + toTake.join(', ') }));
    var acts = el('div', { class: 'acts' });
    if (placeOf(next.item) || (next.item.locationText && !next.item.online)) acts.appendChild(el('a', { href: mapsLink(next.item), target: '_blank', rel: 'noopener' }, 'Y aller'));
    if (late && isFixed(next.item)) acts.appendChild(el('button', { type: 'button', class: 'late-btn', onclick: function () { openSheet(next.item.id, currentDate, 'notify', 'late'); } }, 'Je suis en retard'));
    if (acts.children.length) box.appendChild(acts);
  }

  function renderDay() {
    $('#homeWarning').hidden = !!state.settings.home;
    var plan = planDay(currentDate);
    var count = occurrences(currentDate).length;
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
    plan.out.forEach(function (o) { tl.appendChild(itemCard(o)); });
    if (plan.backHome && plan.out.length) tl.appendChild(el('p', { class: 'travel', text: 'Retour au point de départ ≈ ' + dur(plan.backHome) }));

    var lb = $('#leftover'); lb.innerHTML = '';
    $('#leftoverBox').hidden = !plan.leftover.length;
    plan.leftover.forEach(function (it) {
      lb.appendChild(el('div', { class: 'card' },
        el('div', { class: 'head' }, el('h3', { class: 'title', text: it.title }), el('span', { class: 'badge flex', text: dur(+it.duration || 15) })),
        it.missedDeadline ? el('p', { class: 'meta', text: 'Impossible avant ' + it.deadline + ' avec le reste du planning.' }) : null,
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
    if (!o || n >= st + (+it.duration || 30)) return 0;
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
    return { phone: it.phone || (it.place && it.place.phone) || '', email: it.email || (it.place && it.place.email) || '' };
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
      if (o.past || o.item.done) return;
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
      var d = today(), delay = sos.delay;
      var snap = JSON.stringify(state.items), oldResume = state.settings.resume;
      state.settings.resume = sosResume(delay);
      pv.newLeft.forEach(function (t) { moveOccurrence(t.id, d, { date: addDays(d, 1) }); });
      save(); render();
      toast('Journée réorganisée', function () {
        state.items = JSON.parse(snap); state.settings.resume = oldResume; save(); render(); toast('Action annulée');
      });
      sos.applied = true; sos.result = pv.lines;
      buzz(30);
      renderSOS();
    } }, 'Appliquer ce nouveau plan'));
  }

  // ================= Vue Semaine =================
  function renderWeek(ws) {
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
  $('#exportBtn').addEventListener('click', function () {
    var plan = planDay(currentDate);
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ma Journee//FR', 'CALSCALE:GREGORIAN'];
    plan.out.forEach(function (o) {
      lines.push('BEGIN:VEVENT', 'UID:' + o.item.id + '-' + currentDate + '@ma-journee',
        'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z',
        'DTSTART:' + stamp(currentDate, o.start), 'DTEND:' + stamp(currentDate, o.end),
        'SUMMARY:' + icsEscape(o.item.title));
      if (placeText(o.item)) lines.push('LOCATION:' + icsEscape(placeText(o.item)));
      if (o.travel && !o.past) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Il est temps de partir', 'TRIGGER:-PT' + (o.travel + 5) + 'M', 'END:VALARM');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    var blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'ma-journee-' + currentDate + '.ics' });
    document.body.appendChild(a); a.click(); a.remove();
    toast('Fichier agenda créé : ouvrez-le pour l\'ajouter à votre agenda.');
  });

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
    } else if (p.q) {
      presetQuery = p.q;
      setPresetHint({ parts: [state.settings.home
        ? 'Le lieu le plus proche de chez vous sera trouvé automatiquement. Vous pouvez aussi en chercher un précis ci-dessous.'
        : 'Indiquez votre point de départ dans Réglages pour que l\'app trouve le lieu le plus proche.'] });
    } else if (p.fav) {
      setPresetHint({ warn: true, parts: ['Votre adresse « ' + p.fav + ' » n\'est pas encore enregistrée. ',
        el('button', { type: 'button', class: 'link-btn', 'data-goto': 'settings', onclick: function () { $('#favPreset').value = p.fav; syncFavPreset(); } }, 'L\'ajouter dans Réglages'),
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
    $('#startWrap').hidden = !fixed; $('#deadlineWrap').hidden = fixed;
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
    if (state.settings.home) list.push(Object.assign({ name: 'Maison' }, state.settings.home, { name: 'Maison' }));
    list = list.concat(state.favorites);
    list.forEach(function (f) {
      var on = !!pickedPlace && pickedPlace.lat === f.lat && pickedPlace.lon === f.lon;
      box.appendChild(el('button', { type: 'button', class: 'chip', 'aria-pressed': on ? 'true' : 'false', onclick: function () {
        pickedPlace = { name: f.name, label: f.label, lat: f.lat, lon: f.lon };
        $('#fPlace').value = f.name; $('#fOnline').checked = false; $('#fPlaceResults').innerHTML = '';
        showPicked();
      } }, f.name));
    });
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
    $('#fDate').value = it.date; $('#fStart').value = it.start || ''; $('#fDeadline').value = it.deadline || '';
    $('#fDuration').value = it.duration || 30;
    $('#fPriority').value = it.priority || 'normale';
    $('#fRepeat').value = it.repeat || 'none';
    $('#fPlace').value = it.place ? it.place.name : (it.locationText || '');
    $('#fOnline').checked = !!it.online;
    $('#fPhone').value = it.phone || ''; $('#fEmail').value = it.email || '';
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
      duration: +$('#fDuration').value || 30,
      priority: $('#fPriority').value,
      repeat: $('#fRepeat').value,
      locationText: pickedPlace ? '' : $('#fPlace').value.trim(),
      place: pickedPlace,
      online: $('#fOnline').checked,
      phone: $('#fPhone').value.trim(),
      email: $('#fEmail').value.trim()
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
    $('#homeLabel').textContent = s.home ? 'Départ : ' + s.home.label : 'Aucune adresse enregistrée.';
    $('#sMode').value = s.mode; $('#sStart').value = s.dayStart; $('#sEnd').value = s.dayEnd; $('#sBuffer').value = s.buffer;
    $('#sName').value = s.name || '';
    $('#sMargins').checked = s.smartMargins !== false;
    $('#backupInfo').textContent = s.lastBackup ? 'Dernière sauvegarde : ' + frDate(s.lastBackup, { day: 'numeric', month: 'long', year: 'numeric' }) + '.' : 'Aucune sauvegarde pour l\'instant.';
    var fl = $('#favList'); fl.innerHTML = '';
    if (!state.favorites.length) fl.appendChild(el('p', { class: 'hint', text: 'Aucun lieu favori. Choisissez un lieu dans « Ajouter », puis « Ajouter aux favoris ».' }));
    state.favorites.forEach(function (f) {
      fl.appendChild(el('div', { class: 'favrow' },
        el('div', null, el('strong', { text: f.name }), el('small', { text: f.label })),
        el('button', { class: 'btn danger', type: 'button', onclick: function () {
          state.favorites = state.favorites.filter(function (x) { return x.id !== f.id; }); save(); renderSettings();
        } }, 'Retirer')));
    });
    renderNotifState();
  }
  function syncFavPreset() { $('#favCustomWrap').hidden = $('#favPreset').value !== ''; }
  $('#favPreset').addEventListener('change', syncFavPreset);
  setupSearch($('#favAddr'), $('#favAddrBtn'), $('#favResults'), function (p) {
    var name = $('#favPreset').value || $('#favCustom').value.trim();
    if (!name) { $('#favCustom').focus(); toast('Donnez un nom à ce lieu.'); return; }
    state.favorites = state.favorites.filter(function (f) { return norm(f.name) !== norm(name); });
    state.favorites.push({ id: uid(), name: name, label: p.label, lat: p.lat, lon: p.lon });
    save(); $('#favAddr').value = ''; $('#favCustom').value = ''; renderSettings(); toast('« ' + name + ' » enregistré');
  });

  setupSearch($('#homeInput'), $('#homeBtn'), $('#homeResults'), function (p) {
    state.settings.home = p; save(); renderSettings(); render(); $('#homeInput').value = ''; toast('Point de départ enregistré');
  });
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

  // ================= Démarrage =================
  resetForm();
  render();
  setInterval(function () {
    checkReminders();
    if ($('#view-day').classList.contains('active') && viewMode === 'day' && currentDate === today()) render();
  }, 60 * 1000);
  setTimeout(checkReminders, 2000);
})();
