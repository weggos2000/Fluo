"use strict";

// ---------- toestand ----------
const app = document.getElementById("app");
const titleEl = document.getElementById("title");
const backBtn = document.getElementById("back");
const syncEl = document.getElementById("sync");

let students = [];
let versie = null;
let vandaag = "";
let online = true;
let codeNodig = false;

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
const session = {
  get(key) { try { return sessionStorage.getItem(key) || ""; } catch { return ""; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch {} },
};

// Markeringen die nog niet naar de server konden (bv. geen wifi op de speelplaats)
let wachtrij = store.get("fluo-wachtrij", []);
const adminFilter = Object.assign({ graad: "", jaar: "", klas: "", zoek: "", sort: "punten", dir: -1 }, store.get("fluo-filter", {}));

const GRADEN = { 1: [1, 2], 2: [3, 4], 3: [5, 6], 4: [7] };
const graadVan = (jaar) => Number(Object.keys(GRADEN).find((g) => GRADEN[g].includes(jaar)) || 0);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const naam = (s) => `${s.achternaam} ${s.voornaam}`.trim();
const vergelijkNaam = (a, b) => a.achternaam.localeCompare(b.achternaam, "nl", { sensitivity: "base" })
  || a.voornaam.localeCompare(b.voornaam, "nl", { sensitivity: "base" });
const vergelijkKlas = (a, b) => a.localeCompare(b, "nl", { numeric: true });
const ptsBadge = (p) => `<span class="pts${p ? "" : " zero"}">${p}</span>`;

function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

// ---------- server ----------
async function api(path, body) {
  const headers = { "X-Code": store.get("fluo-code", ""), "X-Admin": session.get("fluo-admin") };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) { store.set("fluo-code", ""); location.hash = "#/code"; throw new Error("code"); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.fout || "Er ging iets mis");
  return data;
}

function zetOnline(value) {
  online = value;
  syncEl.classList.toggle("offline", !value || wachtrij.length > 0);
  syncEl.title = !value ? "Offline – wijzigingen worden later verstuurd" : wachtrij.length ? "Bezig met versturen…" : "Gesynchroniseerd";
}

async function verstuurWachtrij() {
  while (wachtrij.length) {
    try {
      await api("/api/markeer", wachtrij[0]);
    } catch (e) {
      if (e.message === "code") return;
      if (e instanceof TypeError) { zetOnline(false); return; } // netwerkfout: later opnieuw
      toast(e.message); // serverfout (bv. leerling verwijderd): overslaan
    }
    wachtrij.shift();
    store.set("fluo-wachtrij", wachtrij);
  }
}

async function synchroniseer() {
  if (codeNodig && !store.get("fluo-code", "")) return;
  try {
    await verstuurWachtrij();
    const data = await api(`/api/state?versie=${wachtrij.length ? "" : versie ?? ""}`);
    zetOnline(true);
    if (data.ongewijzigd) return;
    versie = data.versie;
    vandaag = data.vandaag;
    students = data.leerlingen;
    for (const m of wachtrij) pasLokaalToe(m); // nog niet verstuurde tikken blijven zichtbaar
    store.set("fluo-cache", { students, vandaag });
    render(true);
  } catch (e) {
    if (e.message !== "code") zetOnline(false);
  }
}

function pasLokaalToe({ id, helm, fluo }) {
  const s = students.find((x) => x.id === id);
  if (!s) return;
  s.helm_dagen += (helm ? 1 : 0) - s.helm_vandaag;
  s.fluo_dagen += (fluo ? 1 : 0) - s.fluo_vandaag;
  s.helm_vandaag = helm ? 1 : 0;
  s.fluo_vandaag = fluo ? 1 : 0;
  s.punten = Math.max(0, s.helm_dagen + s.fluo_dagen + s.correctie);
}

function markeer(id, helm, fluo) {
  const m = { id, helm, fluo };
  pasLokaalToe(m);
  wachtrij = wachtrij.filter((x) => x.id !== id).concat(m);
  store.set("fluo-wachtrij", wachtrij);
  zetOnline(online);
  render();
  synchroniseer();
}

async function download(path) {
  const res = await fetch(path, { headers: { "X-Admin": session.get("fluo-admin"), "X-Code": store.get("fluo-code", "") } });
  if (!res.ok) return toast("Downloaden mislukt");
  const blob = await res.blob();
  const name = (res.headers.get("Content-Disposition") || "").match(/filename="(.+)"/)?.[1] || "fluo.csv";
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- afgeleide gegevens ----------
const jaren = () => [...new Set(students.map((s) => s.jaar))].sort((a, b) => a - b);
const klassenVan = (jaar) => [...new Set(students.filter((s) => s.jaar === jaar).map((s) => s.klas))].sort(vergelijkKlas);
const leerlingenVan = (klas) => students.filter((s) => s.klas === klas).sort(vergelijkNaam);
const totaal = (lijst) => lijst.reduce((t, s) => t + s.punten, 0);

function gefilterd(f) {
  const q = f.zoek.trim().toLowerCase();
  return students.filter((s) =>
    (!f.graad || graadVan(s.jaar) === Number(f.graad)) &&
    (!f.jaar || s.jaar === Number(f.jaar)) &&
    (!f.klas || s.klas === f.klas) &&
    (!q || `${s.voornaam} ${s.achternaam} ${s.achternaam} ${s.klas}`.toLowerCase().includes(q)));
}

function leerlingRij(s, { toonKlas = false } = {}) {
  const vandaagIcon = `${s.helm_vandaag ? "⛑️" : ""}${s.fluo_vandaag ? "🦺" : ""}`;
  return `<button class="row" data-go="#/leerling/${s.id}">
    <span class="nr">${s.nr ?? ""}</span>
    <span class="name">${esc(naam(s))}${toonKlas ? `<small>${esc(s.klas)}</small>` : ""}</span>
    <span class="today">${vandaagIcon}</span>
    ${ptsBadge(s.punten)}
  </button>`;
}

// ---------- schermen ----------
const views = {
  code() {
    setHead("Fluo-actie", false);
    app.innerHTML = `<h2>Schoolcode</h2>
      <p class="muted">Geef de code in die je van de beheerder kreeg. Dit hoeft maar één keer per toestel.</p>
      <form id="f"><input type="password" id="c" autocomplete="off" placeholder="Code" autofocus>
      <div class="actions"><button class="btn primary block">Verder</button></div></form>`;
    app.querySelector("#f").onsubmit = async (e) => {
      e.preventDefault();
      store.set("fluo-code", app.querySelector("#c").value);
      const { ok } = await api("/api/code", {}).catch(() => ({ ok: false }));
      if (!ok) { store.set("fluo-code", ""); return toast("Verkeerde code"); }
      location.hash = "#/";
      synchroniseer();
    };
  },

  home() {
    setHead("Fluo-actie", false);
    const metPunten = students.filter((s) => s.helm_vandaag || s.fluo_vandaag).length;
    app.innerHTML = `
      <div class="summary"><span>Vandaag aangeduid<br><span class="muted small">${esc(datumTekst(vandaag))}</span></span><strong>${metPunten}</strong></div>
      <div class="grid">
        <a class="tile accent" href="#/klassen"><span class="big">🏫 Klassen</span><span>Kies jaar en klas</span></a>
        <a class="tile accent" href="#/zoek"><span class="big">🔍 Zoeken</span><span>Zoek een leerling</span></a>
      </div>
      ${students.length ? "" : `<p class="empty">Er staan nog geen leerlingen in de app.<br>De beheerder kan ze importeren.</p>`}
      <a class="footer-link small" href="#/admin">Beheerder</a>`;
  },

  klassen() {
    setHead("Kies een jaar");
    const perGraad = {};
    for (const j of jaren()) (perGraad[graadVan(j)] ??= []).push(j);
    app.innerHTML = Object.entries(perGraad).map(([g, js]) => `
      <h2>${g > 0 ? `${g}e graad` : "Andere"}</h2>
      <div class="grid">${js.map((j) => {
        const lijst = students.filter((s) => s.jaar === j);
        return `<a class="tile" href="#/jaar/${j}"><span class="big">${j}e jaar</span>
          <span class="muted small">${klassenVan(j).length} klassen · ${totaal(lijst)} punten</span></a>`;
      }).join("")}</div>`).join("") || `<p class="empty">Nog geen leerlingen.</p>`;
  },

  jaar(j) {
    j = Number(j);
    setHead(`${j}e jaar`);
    app.innerHTML = `<div class="grid">${klassenVan(j).map((k) => {
      const lijst = leerlingenVan(k);
      return `<a class="tile" href="#/klas/${encodeURIComponent(k)}"><span class="big">${esc(k)}</span>
        <span class="muted small">${lijst.length} lln · ${totaal(lijst)} punten</span></a>`;
    }).join("")}</div>`;
  },

  klas(k) {
    k = decodeURIComponent(k);
    setHead(`Klas ${k}`);
    const lijst = leerlingenVan(k);
    const vandaagKlas = lijst.filter((s) => s.helm_vandaag || s.fluo_vandaag).length;
    app.innerHTML = `
      <div class="summary"><span>Klastotaal<br><span class="muted small">${vandaagKlas} van ${lijst.length} vandaag aangeduid</span></span><strong>${totaal(lijst)}</strong></div>
      <div class="list">${lijst.map((s) => leerlingRij(s)).join("") || `<p class="empty">Geen leerlingen.</p>`}</div>`;
  },

  leerling(id) {
    const s = students.find((x) => x.id === Number(id));
    if (!s) { setHead("Leerling"); app.innerHTML = `<p class="empty">Leerling niet gevonden.</p>`; return; }
    setHead(s.klas);
    const toggle = (key, emoji, label) => `
      <button class="toggle${s[key + "_vandaag"] ? " on" : ""}" data-key="${key}" aria-pressed="${!!s[key + "_vandaag"]}">
        <span class="emoji">${emoji}</span>${label}
        <span class="state">${s[key + "_vandaag"] ? "✓ +1 punt" : "tik om aan te duiden"}</span>
      </button>`;
    app.innerHTML = `
      <div class="student-head">
        <div class="muted">${s.nr ? `nr. ${s.nr} · ` : ""}${esc(s.klas)}</div>
        <div class="who">${esc(s.voornaam)} ${esc(s.achternaam)}</div>
        <span class="pts">${s.punten} punt${s.punten === 1 ? "" : "en"}</span>
      </div>
      <div class="toggles">${toggle("helm", "⛑️", "Helm")}${toggle("fluo", "🦺", "Fluovestje")}</div>
      <p class="hint muted small">Verkeerd aangeduid? Tik nog eens om het ongedaan te maken.<br>Per dag telt helm en fluo elk maximaal 1 punt.</p>
      <div class="actions"><button class="btn block" data-go="#/klas/${encodeURIComponent(s.klas)}">‹ Terug naar ${esc(s.klas)}</button></div>`;
    app.querySelectorAll(".toggle").forEach((btn) => btn.onclick = () => {
      const helm = btn.dataset.key === "helm" ? !s.helm_vandaag : !!s.helm_vandaag;
      const fluo = btn.dataset.key === "fluo" ? !s.fluo_vandaag : !!s.fluo_vandaag;
      if (navigator.vibrate) navigator.vibrate(15);
      markeer(s.id, helm, fluo);
    });
  },

  zoek() {
    setHead("Zoek een leerling");
    if (!app.querySelector("[data-view=zoek]")) {
      app.innerHTML = `<div data-view="zoek"><input type="search" id="q" placeholder="Naam of klas…" autocomplete="off" value="${esc(session.get("fluo-zoek"))}">
        <div id="res" style="margin-top:12px"></div></div>`;
      const q = app.querySelector("#q");
      q.oninput = () => { session.set("fluo-zoek", q.value); views.zoek(); };
      q.focus();
    }
    const term = app.querySelector("#q").value.trim().toLowerCase();
    const res = app.querySelector("#res");
    if (term.length < 2) { res.innerHTML = `<p class="empty">Typ minstens 2 letters.</p>`; return; }
    const hits = gefilterd({ graad: "", jaar: "", klas: "", zoek: term }).sort(vergelijkNaam).slice(0, 60);
    res.innerHTML = hits.length ? `<div class="list">${hits.map((s) => leerlingRij(s, { toonKlas: true })).join("")}</div>` : `<p class="empty">Niemand gevonden.</p>`;
  },

  admin(tab = "overzicht") {
    if (!adminTabs[tab]) tab = "overzicht";
    if (!session.get("fluo-admin")) return adminLogin();
    setHead("Beheerder");
    if (app.querySelector("[data-view=admin]")?.dataset.tab !== tab) {
      const tabs = [["overzicht", "📊 Overzicht"], ["loting", "🎲 Loting"], ["leerlingen", "👥 Leerlingen"]];
      app.innerHTML = `<div data-view="admin" data-tab="${tab}">
        <nav class="tabs">${tabs.map(([t, l]) => `<a href="#/admin/${t}" class="${t === tab ? "active" : ""}">${l}</a>`).join("")}
          <a href="#/" id="logout">Afmelden</a></nav>
        <div id="filters"></div><div id="body"></div></div>`;
      app.querySelector("#logout").onclick = () => session.set("fluo-admin", "");
      if (tab !== "leerlingen") filterBalk();
      adminTabs[tab].setup?.();
    }
    adminTabs[tab].update();
  },
};

function datumTekst(iso) {
  if (!iso) return "";
  return new Date(iso + "T12:00").toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" });
}

function setHead(title, back = true) {
  titleEl.textContent = title;
  backBtn.hidden = !back;
}

// ---------- beheerder ----------
function adminLogin() {
  setHead("Beheerder");
  app.innerHTML = `<h2>Aanmelden</h2>
    <form id="f"><input type="password" id="pw" placeholder="Beheerderswachtwoord" autocomplete="current-password" autofocus>
    <div class="actions"><button class="btn primary block">Aanmelden</button></div></form>`;
  app.querySelector("#f").onsubmit = async (e) => {
    e.preventDefault();
    session.set("fluo-admin", app.querySelector("#pw").value);
    const { ok } = await api("/api/admin/login", {}).catch(() => ({ ok: false }));
    if (!ok) { session.set("fluo-admin", ""); return toast("Verkeerd wachtwoord"); }
    route();
  };
}

function filterBalk() {
  const el = app.querySelector("#filters");
  const opties = (lijst, gekozen, alles) => `<option value="">${alles}</option>` +
    lijst.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(gekozen) ? "selected" : ""}>${esc(l)}</option>`).join("");
  const teken = () => {
    const js = jaren().filter((j) => !adminFilter.graad || graadVan(j) === Number(adminFilter.graad));
    const ks = [...new Set(students.filter((s) => js.includes(s.jaar) && (!adminFilter.jaar || s.jaar === Number(adminFilter.jaar))).map((s) => s.klas))].sort(vergelijkKlas);
    const graden = [...new Set(jaren().map(graadVan))].filter(Boolean);
    el.innerHTML = `<div class="filters">
      <div><label>Graad</label><select data-f="graad">${opties(graden.map((g) => [g, `${g}e graad`]), adminFilter.graad, "Alle graden")}</select></div>
      <div><label>Jaar</label><select data-f="jaar">${opties(js.map((j) => [j, `${j}e jaar`]), adminFilter.jaar, "Alle jaren")}</select></div>
      <div><label>Klas</label><select data-f="klas">${opties(ks.map((k) => [k, k]), adminFilter.klas, "Alle klassen")}</select></div>
      <div><label>Zoek</label><input type="search" data-f="zoek" value="${esc(adminFilter.zoek)}" placeholder="Naam…"></div></div>`;
    el.querySelectorAll("[data-f]").forEach((input) => input[input.tagName === "SELECT" ? "onchange" : "oninput"] = () => {
      adminFilter[input.dataset.f] = input.value;
      if (input.dataset.f === "graad") { adminFilter.jaar = ""; adminFilter.klas = ""; }
      if (input.dataset.f === "jaar") adminFilter.klas = "";
      store.set("fluo-filter", adminFilter);
      if (input.tagName === "SELECT") teken();
      views.admin(app.querySelector("[data-view=admin]").dataset.tab);
    });
  };
  teken();
}

const adminTabs = {
  overzicht: {
    update() {
      const body = app.querySelector("#body");
      const kolommen = [["klas", "Klas"], ["nr", "Nr", "num"], ["achternaam", "Naam"], ["helm_dagen", "⛑️", "num"], ["fluo_dagen", "🦺", "num"], ["correctie", "±", "num"], ["punten", "Punten", "num"]];
      const sorteer = (a, b) => {
        const k = adminFilter.sort;
        const v = k === "klas" ? vergelijkKlas(a.klas, b.klas) || vergelijkNaam(a, b)
          : k === "achternaam" ? vergelijkNaam(a, b)
          : (a[k] ?? 0) - (b[k] ?? 0) || vergelijkNaam(a, b) * -adminFilter.dir;
        return v * adminFilter.dir;
      };
      const lijst = gefilterd(adminFilter).sort(sorteer);
      body.innerHTML = `
        <div class="summary"><span>${lijst.length} leerlingen<br><span class="muted small">${lijst.filter((s) => s.punten).length} met punten</span></span><strong>${totaal(lijst)}</strong></div>
        <div class="table-wrap"><table><thead><tr>${kolommen.map(([k, l, c]) =>
          `<th class="${c || ""}" data-sort="${k}">${l}${adminFilter.sort === k ? (adminFilter.dir < 0 ? " ▼" : " ▲") : ""}</th>`).join("")}</tr></thead>
        <tbody>${lijst.map((s) => `<tr data-id="${s.id}"><td>${esc(s.klas)}</td><td class="num">${s.nr ?? ""}</td>
          <td>${esc(naam(s))}</td><td class="num">${s.helm_dagen}</td><td class="num">${s.fluo_dagen}</td>
          <td class="num">${s.correctie || ""}</td><td class="num"><strong>${s.punten}</strong></td></tr>`).join("")}</tbody></table></div>
        <p class="muted small">Tik op een kolomtitel om te sorteren, op een leerling om punten aan te passen.</p>`;
      body.querySelectorAll("th").forEach((th) => th.onclick = () => {
        const k = th.dataset.sort;
        adminFilter.dir = adminFilter.sort === k ? -adminFilter.dir : (["punten", "helm_dagen", "fluo_dagen", "correctie"].includes(k) ? -1 : 1);
        adminFilter.sort = k;
        store.set("fluo-filter", adminFilter);
        this.update();
      });
      body.querySelectorAll("tbody tr").forEach((tr) => tr.onclick = () => bewerkLeerling(Number(tr.dataset.id)));
    },
  },

  loting: {
    setup() {
      app.querySelector("#body").innerHTML = `<div id="pot"></div>
        <label for="n">Aantal winnaars</label><input type="number" id="n" min="1" value="${store.get("fluo-aantal", 3)}">
        <div class="actions"><button class="btn primary block" id="trek">🎲 Trek winnaars</button></div>
        <div id="winnaars"></div>`;
      app.querySelector("#trek").onclick = async () => {
        const aantal = Math.max(1, Number(app.querySelector("#n").value) || 1);
        store.set("fluo-aantal", aantal);
        const kandidaten = gefilterd(adminFilter);
        if (!kandidaten.some((s) => s.punten)) return toast("Niemand in deze selectie heeft punten");
        try {
          const r = await api("/api/admin/loting", { aantal, ids: kandidaten.map((s) => s.id) });
          app.querySelector("#winnaars").innerHTML = `<h2>Winnaars</h2>` + r.winnaars.map((w, i) => `
            <div class="winner" style="animation-delay:${i * 0.25}s"><span class="place">${i + 1}</span>
            <span style="flex:1"><strong>${esc(w.voornaam)} ${esc(w.achternaam)}</strong><br>${esc(w.klas)}</span>${ptsBadge(w.punten)}</div>`).join("")
            + (r.winnaars.length < aantal ? `<p class="muted small">Er waren maar ${r.winnaars.length} leerlingen met punten.</p>` : "");
        } catch (e) { toast(e.message); }
      };
    },
    update() {
      const k = gefilterd(adminFilter).filter((s) => s.punten);
      const lotjes = totaal(k);
      app.querySelector("#pot").innerHTML = `<div class="summary"><span>In de pot<br><span class="muted small">${k.length} leerlingen met punten</span></span><strong>${lotjes} 🎟️</strong></div>
        <p class="muted small">Elk punt is één lotje: wie 7 punten heeft, heeft 7× zoveel kans als wie 1 punt heeft. Elke leerling kan maar één keer winnen. De filters hierboven bepalen wie meedoet.</p>`;
    },
  },

  leerlingen: {
    setup() {
      const body = app.querySelector("#body");
      body.innerHTML = `
        <h2>Exporteren (Excel)</h2>
        <div class="actions"><button class="btn" id="exp1">⬇️ Totalen per leerling</button><button class="btn" id="exp2">⬇️ Alle registraties per dag</button></div>
        <h2>Leerlingen importeren</h2>
        <p class="muted small">Kies een CSV-bestand (bv. uit Excel of Smartschool) of plak de lijst. Kolommen: <code>klas;nr;achternaam;voornaam</code> (een titelrij met die namen mag, de volgorde is dan vrij).</p>
        <input type="file" id="file" accept=".csv,.txt,text/csv">
        <textarea id="csv" placeholder="3A;1;Peeters;Emma&#10;3A;2;Janssens;Lucas"></textarea>
        <label><input type="checkbox" id="vervang"> Bestaande leerlingen én alle punten eerst wissen (nieuw schooljaar)</label>
        <div class="actions"><button class="btn primary" id="imp">Importeren</button></div>
        <h2>Leerling toevoegen</h2>
        <div class="actions"><button class="btn" id="nieuw">➕ Nieuwe leerling</button></div>
        <h2>Alles op nul</h2>
        <p class="muted small">Wist alle aanduidingen en correcties. De leerlingen blijven staan. Download eerst een export!</p>
        <div class="actions"><button class="btn danger" id="reset">Alle punten wissen</button></div>`;
      body.querySelector("#exp1").onclick = () => download("/api/admin/export.csv");
      body.querySelector("#exp2").onclick = () => download("/api/admin/registraties.csv");
      body.querySelector("#file").onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const buf = await f.arrayBuffer();
        let text = new TextDecoder("utf-8").decode(buf);
        if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buf); // oudere Excel-export
        body.querySelector("#csv").value = text;
      };
      body.querySelector("#imp").onclick = async () => {
        const vervangen = body.querySelector("#vervang").checked;
        if (vervangen && prompt("Typ WISSEN om alle leerlingen en punten te verwijderen") !== "WISSEN") return;
        try {
          const r = await api("/api/admin/import", { csv: body.querySelector("#csv").value, vervangen });
          toast(`${r.toegevoegd} toegevoegd, ${r.bijgewerkt} bijgewerkt`);
          body.querySelector("#csv").value = "";
          synchroniseer();
        } catch (e) { toast(e.message); }
      };
      body.querySelector("#nieuw").onclick = () => bewerkLeerling(null);
      body.querySelector("#reset").onclick = async () => {
        if (prompt("Typ NUL om alle punten van alle leerlingen te wissen") !== "NUL") return;
        await api("/api/admin/reset", {}).catch((e) => toast(e.message));
        synchroniseer();
      };
    },
    update() {},
  },
};

function bewerkLeerling(id) {
  const s = students.find((x) => x.id === id) || { klas: adminFilter.klas, nr: "", achternaam: "", voornaam: "", correctie: 0, punten: 0, helm_dagen: 0, fluo_dagen: 0 };
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog">
    ${id ? `<h2>${esc(naam(s))}</h2>
      <p class="muted small">⛑️ ${s.helm_dagen} dagen · 🦺 ${s.fluo_dagen} dagen · correctie ${s.correctie > 0 ? "+" : ""}${s.correctie}</p>
      <div class="stepper"><button type="button" class="btn" data-d="-1">−</button><strong id="p">${s.punten}</strong><button type="button" class="btn" data-d="1">+</button></div>
      <p class="muted small" style="text-align:center">Punten manueel bijstellen</p>` : `<h2>Nieuwe leerling</h2>`}
    <div class="filters"><div><label>Klas</label><input type="text" name="klas" value="${esc(s.klas)}" required></div>
      <div><label>Nr</label><input type="number" name="nr" value="${s.nr ?? ""}"></div></div>
    <label>Achternaam</label><input type="text" name="achternaam" value="${esc(s.achternaam)}" required>
    <label>Voornaam</label><input type="text" name="voornaam" value="${esc(s.voornaam)}">
    <div class="actions">
      <button class="btn primary" value="save">Opslaan</button><button class="btn" value="">Sluiten</button>
      ${id ? `<button class="btn danger" value="delete" formnovalidate>Verwijderen</button>` : ""}
    </div></form>`;
  document.body.append(dlg);
  dlg.querySelectorAll("[data-d]").forEach((b) => b.onclick = async () => {
    try {
      await api("/api/admin/correctie", { id, delta: Number(b.dataset.d) });
      pasCorrectieToe(s, Number(b.dataset.d));
      dlg.querySelector("#p").textContent = s.punten;
      render();
    } catch (e) { toast(e.message); }
  });
  dlg.addEventListener("close", async () => {
    const form = new FormData(dlg.querySelector("form"));
    dlg.remove();
    try {
      if (dlg.returnValue === "save") {
        await api("/api/admin/leerling", { id, ...Object.fromEntries(form) });
        toast("Opgeslagen");
      } else if (dlg.returnValue === "delete" && confirm(`${naam(s)} en alle punten verwijderen?`)) {
        await api("/api/admin/verwijder", { id });
        toast("Verwijderd");
      }
    } catch (e) { toast(e.message); }
    synchroniseer();
  });
  dlg.showModal();
}

function pasCorrectieToe(s, delta) {
  s.correctie += delta;
  s.punten = Math.max(0, s.helm_dagen + s.fluo_dagen + s.correctie);
}

// ---------- navigatie ----------
function route() {
  render();
  window.scrollTo(0, 0);
}

function render(fromSync = false) {
  if (fromSync && document.querySelector("dialog[open]")) return; // niet storen tijdens bewerken
  const [view, ...args] = location.hash.replace(/^#\/?/, "").split("/");
  if (codeNodig && !store.get("fluo-code", "") && view !== "code") { location.hash = "#/code"; return; }
  (views[view] || views.home)(...args);
}

backBtn.onclick = () => {
  const [view, arg] = location.hash.replace(/^#\/?/, "").split("/");
  const s = view === "leerling" && students.find((x) => x.id === Number(arg));
  location.hash = s ? `#/klas/${encodeURIComponent(s.klas)}`
    : view === "klas" ? `#/jaar/${students.find((x) => x.klas === decodeURIComponent(arg))?.jaar ?? ""}`
    : view === "jaar" ? "#/klassen" : "#/";
};
app.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) location.hash = go.dataset.go;
});
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => { if (!document.hidden) synchroniseer(); });
window.addEventListener("online", synchroniseer);

(async function start() {
  const cache = store.get("fluo-cache", null);
  if (cache) { students = cache.students; vandaag = cache.vandaag; }
  try { codeNodig = (await (await fetch("/api/config")).json()).codeNodig; } catch { zetOnline(false); }
  route();
  synchroniseer();
  setInterval(() => { if (!document.hidden) synchroniseer(); }, 4000);
})();
