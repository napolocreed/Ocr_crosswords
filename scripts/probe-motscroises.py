#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sonde ciblée : peut-on interroger un site de solutions DEPUIS la PWA ?

Le sondage général (`probe-solvers.py`) a fait son travail et laissé une seule
question ouverte, mais c'est celle qui décide de toute l'architecture.

Il a mesuré les en-têtes CORS sur les **pages d'accueil**. Or la PWA n'appellera
jamais une page d'accueil : elle appellera une page de résultats. Un site peut
parfaitement autoriser l'une et pas l'autre, et confondre les deux ferait
annoncer « aucun serveur nécessaire » sur une mesure qui ne le montre pas.

Deux issues, et elles n'ont pas le même prix :

  · CORS présent sur la page de résultats → la PWA appelle le site directement,
    tout reste sur GitHub Pages, la promesse « aucun serveur » du README tient.
  · CORS absent → il faut un relais côté serveur (Cloud Run), et cette promesse
    doit être réécrite.

Ce script tranche. Il s'acharne sur motscroises.fr — le seul site dont l'accueil
autorisait l'origine GitHub Pages — en cherchant son URL de recherche par tous
les moyens : ses propres liens, ses sitemaps, et une liste de formes usuelles.
Puis il vérifie CORS **sur la page qui a répondu**. Il refait ensuite la même
vérification, en plus court, sur les quatre autres sites qui savent répondre.

Usage
-----
Ouvrir dans Pydroid 3, appuyer sur ▶. Rien à taper, rien à installer.
Le rapport s'affiche à la fin, entre deux repères, prêt à copier.
"""

from __future__ import annotations

import gzip
import os
import re
import ssl
import sys
import time
import unicodedata
import zlib
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

ORIGIN = "https://napolocreed.github.io"
UA = ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/120.0.0.0 Mobile Safari/537.36")
TIMEOUT = 25
DELAY = 0.4

# Définitions dont la réponse est connue d'avance : sans elles, « la page a
# répondu 200 » ne prouve rien.
CLUES = (
    ("ASTRE DU JOUR", 6, ("SOLEIL",)),
    ("FLEUVE D'ÉGYPTE", 3, ("NIL",)),
    ("CAPITALE DU JAPON", 5, ("TOKYO",)),
)

TARGET = "https://www.motscroises.fr/"

# Formes d'URL usuelles sur ce genre de site. Elles ne sont qu'un filet : le
# gros du travail vient des liens et des sitemaps du site lui-même.
GUESSES = (
    "/{slug}",
    "/solution/{slug}",
    "/solutions/{slug}",
    "/definition/{slug}",
    "/definitions/{slug}",
    "/mots-fleches/{slug}",
    "/mots-croises/{slug}",
    "/recherche/{slug}",
    "/{slug}-{len}-lettres",
    "/solution/{slug}/{len}",
    "/?s={plus}",
    "/recherche?q={plus}",
    "/recherche?s={plus}",
)

# Les quatre autres sites qui ont su répondre. On leur repose la seule question
# qui reste : CORS sur la page de résultats, oui ou non.
CONTROLS = (
    ("FSolver", "https://www.fsolver.fr/", ("/mots-fleches/{slug}",)),
    ("Solutions-Mots-Fleches", "https://www.solutions-mots-fleches.com/", ("/{slug}",)),
    ("Mots-Croises.ch", "https://www.mots-croises.ch/", ()),
    ("Mots-Croises-Solutions", "https://mots-croises-solutions.com/", ("/{slug}",)),
)


# --------------------------------------------------------------------------- #
# Texte
# --------------------------------------------------------------------------- #

def deaccent(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text)
                   if unicodedata.category(c) != "Mn")


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", deaccent(text).lower()).strip("-")


def expand(template: str, clue: str, length: int) -> str:
    return template.format(
        slug=slugify(clue),
        plus=urlparse.quote_plus(clue),
        star=urlparse.quote(deaccent(clue).upper().replace(" ", "*"), safe="*'"),
        stars=re.sub(r"[^A-Z0-9]+", "*", deaccent(clue).upper()).strip("*"),
        len=length,
    )


TAGS = re.compile(r"<[^>]+>")
SCRIPTS = re.compile(r"<(script|style|noscript)\b.*?</\1>", re.I | re.S)


def strip_tags(markup: str) -> str:
    import html as html_mod
    text = SCRIPTS.sub(" ", markup)
    return re.sub(r"\s+", " ", html_mod.unescape(TAGS.sub(" ", text))).strip()


def snippets(markup: str, needle: str, radius: int = 200, limit: int = 2) -> list[str]:
    out: list[str] = []
    covered = 0
    for match in re.finditer(re.escape(needle), markup, re.I):
        if match.start() < covered:
            continue
        start, end = max(0, match.start() - radius), min(len(markup), match.end() + radius)
        covered = end
        out.append(re.sub(r"\s+", " ", markup[start:end]).strip())
        if len(out) >= limit:
            break
    return out


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class Resp:
    def __init__(self, url: str) -> None:
        self.url = url
        self.final_url = ""
        self.status = 0
        self.headers: dict[str, str] = {}
        self.text = ""
        self.body = b""
        self.error = ""
        self.ms = 0

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 400 and not self.error


def _decode(raw: bytes, headers: dict[str, str]) -> str:
    enc = (headers.get("content-encoding") or "").lower()
    try:
        if "gzip" in enc:
            raw = gzip.decompress(raw)
        elif "deflate" in enc:
            raw = zlib.decompress(raw, -zlib.MAX_WBITS)
    except Exception:
        pass
    charset = ""
    found = re.search(r"charset=([\w\-]+)", headers.get("content-type", ""), re.I)
    if found:
        charset = found.group(1)
    if not charset:
        meta = re.search(r"charset=[\"']?([\w\-]+)", raw[:4096].decode("latin-1", "replace"), re.I)
        if meta:
            charset = meta.group(1)
    for candidate in (charset, "utf-8", "iso-8859-1"):
        if not candidate:
            continue
        try:
            return raw.decode(candidate)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", "replace")


_last = [0.0]


def http(url: str, method: str = "GET") -> Resp:
    gap = time.time() - _last[0]
    if _last[0] and gap < DELAY:
        time.sleep(DELAY - gap)

    resp = Resp(url)
    headers = {
        "User-Agent": UA,
        "Accept-Encoding": "gzip, deflate",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        # L'en-tête qui fait toute la mesure : c'est celui que le navigateur
        # enverra depuis la PWA, et c'est lui qui déclenche la réponse CORS.
        "Origin": ORIGIN,
    }
    if method == "OPTIONS":
        headers["Access-Control-Request-Method"] = "GET"
    request = urlrequest.Request(url, method=method, headers=headers)
    started = time.time()

    def attempt(context):
        with urlrequest.urlopen(request, timeout=TIMEOUT, context=context) as raw:
            resp.body = raw.read()
            resp.headers = {k.lower(): v for k, v in raw.headers.items()}
            resp.status = raw.status
            resp.final_url = raw.geturl()
            resp.text = _decode(resp.body, resp.headers)

    try:
        attempt(None)
    except urlerror.HTTPError as exc:
        # Un 404 porte quand même ses en-têtes, CORS compris.
        try:
            resp.body = exc.read()
        except Exception:
            resp.body = b""
        resp.headers = {k.lower(): v for k, v in (exc.headers or {}).items()}
        resp.status = exc.code
        resp.final_url = getattr(exc, "url", url) or url
        resp.text = _decode(resp.body, resp.headers)
        resp.error = "HTTP %s" % exc.code
    except ssl.SSLError:
        try:
            relaxed = ssl.create_default_context()
            relaxed.check_hostname = False
            relaxed.verify_mode = ssl.CERT_NONE
            attempt(relaxed)
        except Exception as inner:
            resp.error = "TLS: %s" % inner
    except Exception as exc:
        resp.error = "%s: %s" % (type(exc).__name__, exc)

    resp.ms = int((time.time() - started) * 1000)
    _last[0] = time.time()
    return resp


CORS_KEYS = ("access-control-allow-origin", "access-control-allow-methods",
             "access-control-allow-headers", "access-control-max-age")


def cors_of(resp: Resp) -> dict[str, str]:
    return {k: resp.headers[k] for k in CORS_KEYS if k in resp.headers}


def cors_ok(headers: dict[str, str]) -> tuple[bool, str]:
    allow = (headers.get("access-control-allow-origin") or "").strip()
    if not allow:
        return False, "aucun en-tête Access-Control-Allow-Origin"
    if allow == "*":
        return True, "Access-Control-Allow-Origin: *"
    if allow.rstrip("/") == ORIGIN.rstrip("/"):
        return True, "Access-Control-Allow-Origin: %s" % allow
    return False, "Access-Control-Allow-Origin: %s (ne couvre pas l'origine)" % allow


# --------------------------------------------------------------------------- #
# Découverte
# --------------------------------------------------------------------------- #

FORM = re.compile(r"<form\b(?P<attrs>[^>]*)>(?P<inner>.*?)</form>", re.I | re.S)
FIELD = re.compile(r"<(input|select|textarea)\b(?P<attrs>[^>]*)>", re.I)
ATTR = re.compile(r"(\w[\w:-]*)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)")
LINK = re.compile(r"<a\b[^>]+href=[\"']([^\"'#][^\"']*)[\"']", re.I)
SLUG_SEG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+){2,}$")


def attrs_of(fragment: str) -> dict[str, str]:
    return {k.lower(): v.strip("\"'") for k, v in ATTR.findall(fragment)}


def forms_of(markup: str, base: str) -> list[dict]:
    out = []
    for match in FORM.finditer(markup):
        info = attrs_of(match.group("attrs"))
        fields = []
        for tag, raw in FIELD.findall(match.group("inner")):
            entry = attrs_of(raw)
            entry["tag"] = tag.lower()
            fields.append(entry)
        out.append({"action": urlparse.urljoin(base, info.get("action") or base),
                    "method": (info.get("method") or "get").lower(),
                    "fields": fields})
    return out


def form_url(form: dict, clue: str, length: int) -> str | None:
    params: dict[str, str] = {}
    text_field = ""
    for entry in form["fields"]:
        name = entry.get("name")
        if not name:
            continue
        kind = (entry.get("type") or "").lower()
        if kind in ("submit", "button", "image", "reset"):
            continue
        if kind in ("checkbox", "radio") and "checked" not in entry:
            continue
        if not text_field and entry["tag"] in ("input", "textarea") and kind in ("", "text", "search"):
            text_field, params[name] = name, clue
            continue
        if re.search(r"lettre|nombre|len|taille|caract", name, re.I):
            params[name] = str(length)
            continue
        params[name] = entry.get("value", "")
    if not text_field:
        return None
    joiner = "&" if "?" in form["action"] else "?"
    return form["action"] + joiner + urlparse.urlencode(params)


def shape_of(path: str) -> str:
    out = []
    for segment in path.strip("/").split("/"):
        if not segment:
            continue
        if segment.isdigit():
            out.append("{n}")
        elif SLUG_SEG.match(segment) or len(segment) > 24:
            out.append("{slug}")
        else:
            out.append(segment)
    return "/" + "/".join(out)


def links_of(markup: str, base: str) -> list[str]:
    root = "%s://%s" % urlparse.urlsplit(base)[:2]
    out = []
    for href in LINK.findall(markup):
        absolute = urlparse.urljoin(base, href)
        if absolute.startswith(root) and urlparse.urlsplit(absolute).path not in ("", "/"):
            out.append(absolute)
    return out


def templates_from(urls: list[str], limit: int = 8) -> list[str]:
    """Une URL observée devient un gabarit : le segment-définition passe en {slug}."""
    found: dict[str, str] = {}
    for url in urls:
        split = urlparse.urlsplit(url)
        segments = [s for s in split.path.strip("/").split("/") if s]
        for i, segment in enumerate(segments):
            if not (SLUG_SEG.match(segment) or len(segment) > 24):
                continue
            shaped = segments[:]
            shaped[i] = "{slug}"
            found.setdefault("/" + "/".join(shaped), url)
            break
        if len(found) >= limit:
            break
    return list(found)


def read_sitemap(url: str) -> tuple[bool, list[str]]:
    resp = http(url)
    if not resp.ok:
        return False, []
    body = resp.body
    if url.endswith(".gz") or body[:2] == b"\x1f\x8b":
        try:
            body = gzip.decompress(body)
        except Exception:
            pass
    text = body.decode("utf-8", "replace")
    return "<sitemapindex" in text, re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", text)


# --------------------------------------------------------------------------- #
# Le test qui compte
# --------------------------------------------------------------------------- #

def try_url(url: str, clue: str, length: int, answers: tuple[str, ...]) -> tuple[Resp, list[str]]:
    resp = http(url)
    if not resp.ok:
        return resp, []
    plain = deaccent(strip_tags(resp.text)).upper()
    hits = [a for a in answers if re.search(r"\b%s\b" % re.escape(a), plain)]
    return resp, hits


def investigate(name: str, home_url: str, guesses: tuple[str, ...],
                deep: bool, out: list[str]) -> dict:
    """Trouve une URL de résultats qui répond, puis mesure CORS dessus."""
    say = out.append
    result = {"name": name, "url": "", "cors": {}, "cors_ok": False,
              "verdict": "", "snippets": [], "shapes": [], "answers": []}

    print("\n=== %s ===" % name, flush=True)
    home = http(home_url)
    if not home.ok:
        result["verdict"] = "injoignable (%s)" % (home.error or home.status)
        print("  injoignable", flush=True)
        return result
    print("  accueil %s en %s ms" % (home.status, home.ms), flush=True)
    home_cors_ok, home_cors_why = cors_ok(cors_of(home))

    root = "%s://%s" % urlparse.urlsplit(home_url)[:2]
    observed = links_of(home.text, home.final_url or home_url)

    if deep:
        # Descendre d'un cran : les pages de rubrique portent les liens vers les
        # définitions, que l'accueil ne montre pas toujours.
        print("  liens…", flush=True)
        for url in observed[:6]:
            page = http(url)
            if page.ok:
                observed.extend(links_of(page.text, page.final_url or url))

        print("  sitemaps…", flush=True)
        # Filtré sur le même hôte : un sitemap peut lister d'autres domaines, et
        # une forme d'URL venue d'ailleurs ne dit rien de celui qu'on interroge.
        def same_site(urls: list[str]) -> list[str]:
            return [u for u in urls if u.startswith(root)]

        is_index, locs = read_sitemap(root + "/sitemap.xml")
        if is_index:
            for child in same_site(locs)[:8]:
                _, pages = read_sitemap(child)
                observed.extend(same_site(pages)[:20])
        else:
            observed.extend(same_site(locs)[:40])

    shapes: dict[str, tuple[int, str]] = {}
    for url in observed:
        shape = shape_of(urlparse.urlsplit(url).path)
        count, example = shapes.get(shape, (0, url))
        shapes[shape] = (count + 1, example)
    result["shapes"] = sorted(
        ({"shape": s, "count": n, "example": e} for s, (n, e) in shapes.items()),
        key=lambda row: -row["count"])[:12]

    candidates: list[str] = [root + g for g in guesses]
    candidates += [root + t for t in templates_from(observed)]
    for form in forms_of(home.text, home.final_url or home_url)[:3]:
        built = form_url(form, CLUES[0][0], CLUES[0][1])
        if built:
            candidates.append(built.replace(
                urlparse.quote_plus(CLUES[0][0]), "{plus}").replace(
                urlparse.quote(CLUES[0][0]), "{plus}"))
    # Dédoublonner en gardant l'ordre : les formes devinées d'abord, les formes
    # observées ensuite — mais c'est presque toujours une observée qui gagne.
    seen: set[str] = set()
    candidates = [c for c in candidates if not (c in seen or seen.add(c))]

    print("  %s URL candidates…" % len(candidates), flush=True)
    clue, length, answers = CLUES[0]
    winner = ""
    for candidate in candidates:
        url = expand(candidate, clue, length) if "{" in candidate else candidate
        resp, hits = try_url(url, clue, length, answers)
        mark = "✓" if hits else ("·" if resp.ok else "⨯")
        print("    %s %s" % (mark, url[:76]), flush=True)
        if hits:
            winner = candidate
            result["url"] = url
            result["snippets"] = snippets(resp.text, hits[0])
            result["answers"].append("%s → %s" % (clue, "/".join(hits)))
            # LA mesure : CORS sur la page de résultats, pas sur l'accueil.
            headers = cors_of(resp)
            result["cors"] = headers
            result["cors_ok"], result["verdict"] = cors_ok(headers)
            break

    if not winner:
        result["verdict"] = "aucune URL de recherche ne rend la solution attendue"
        say("- Accueil : %s (%s)" % (home_cors_why,
                                     "CORS ouvert" if home_cors_ok else "pas de CORS"))
        say("- **%s** — donc CORS non mesuré sur une page de résultats." % result["verdict"])
        say("- %s URL essayées : %s" % (
            len(candidates), ", ".join("`%s`" % c.replace(root, "") for c in candidates[:12])))
        return result

    # Confirmer sur les autres définitions : une réussite unique peut être un
    # hasard de page, deux ou trois ne le sont plus.
    for clue2, length2, answers2 in CLUES[1:]:
        url = expand(winner, clue2, length2) if "{" in winner else winner
        resp, hits = try_url(url, clue2, length2, answers2)
        print("    %s %s" % ("✓" if hits else "·", url[:76]), flush=True)
        result["answers"].append("%s → %s" % (clue2, "/".join(hits) if hits else "rien"))
        if hits and not result["snippets"]:
            result["snippets"] = snippets(resp.text, hits[0])

    preflight = http(result["url"], method="OPTIONS")
    result["preflight"] = "%s %s" % (
        preflight.status, cors_ok(cors_of(preflight))[1])

    say("- Gabarit qui répond : `%s`" % winner)
    say("- URL : `%s`" % result["url"])
    say("- Accueil : %s" % home_cors_why)
    say("- **Page de résultats : %s**" % result["verdict"])
    say("- Préflight OPTIONS : %s" % result["preflight"])
    for line in result["answers"]:
        say("- %s" % line)
    return result


# --------------------------------------------------------------------------- #
# Rapport
# --------------------------------------------------------------------------- #

def main() -> int:
    print("Sonde ciblée — CORS sur les pages de RÉSULTATS")
    print("Origine testée : %s" % ORIGIN)
    print("Le rapport s'affiche à la fin, prêt à copier.")

    lines: list[str] = []
    started = time.time()

    lines.append("# Sonde ciblée — appelable depuis la PWA ?")
    lines.append("")
    lines.append("Origine testée : `%s`" % ORIGIN)
    lines.append("")
    lines.append("## motscroises.fr — en profondeur")
    lines.append("")
    target = investigate("motscroises.fr", TARGET, GUESSES, True, lines)
    lines.append("")

    if target["shapes"]:
        lines.append("Formes d'URL observées sur le site :")
        lines.append("")
        for row in target["shapes"][:10]:
            lines.append("- `%s` ×%s — ex. `%s`" % (row["shape"], row["count"], row["example"]))
        lines.append("")

    if target["snippets"]:
        lines.append("Extrait HTML autour de la solution :")
        lines.append("")
        lines.append("```html")
        for snippet in target["snippets"]:
            lines.append(snippet[:700])
            lines.append("")
        lines.append("```")
        lines.append("")

    lines.append("## Les autres sites — CORS sur leur page de résultats")
    lines.append("")
    controls = []
    for name, home_url, guesses in CONTROLS:
        block: list[str] = []
        controls.append(investigate(name, home_url, guesses, False, block))
        lines.append("### %s" % name)
        lines.append("")
        lines.extend(block or ["- %s" % controls[-1]["verdict"]])
        if controls[-1]["snippets"]:
            lines.append("")
            lines.append("```html")
            lines.append(controls[-1]["snippets"][0][:600])
            lines.append("```")
        lines.append("")

    lines.append("## Verdict")
    lines.append("")
    everyone = [target] + controls
    direct = [r for r in everyone if r["cors_ok"]]
    answering = [r for r in everyone if r["url"]]
    silent = [r for r in everyone if not r["url"]]
    if direct:
        lines.append("**%s appelable(s) directement depuis GitHub Pages**, CORS vérifié sur la "
                     "page de résultats elle-même. Aucun serveur nécessaire."
                     % ", ".join(r["name"] for r in direct))
    elif answering:
        lines.append("**Aucun des sites interrogeables n'autorise CORS sur sa page de "
                     "résultats.** %s répond(ent) correctement, mais il faudra un relais côté "
                     "serveur — et réécrire la promesse « aucun serveur » du README."
                     % ", ".join(r["name"] for r in answering))
    else:
        lines.append("**Aucun site n'a rendu la solution attendue.** Les formes d'URL relevées "
                     "plus haut sont ce qu'il reste à examiner à la main.")
    # Ne pas laisser croire que le verdict porte sur tout le monde : un site
    # qu'on n'a pas su interroger n'a pas été mesuré, il n'a pas été innocenté.
    if silent and answering:
        lines.append("")
        lines.append("Non mesuré(s), faute d'avoir trouvé leur URL de recherche : %s. "
                     "Le verdict ci-dessus ne dit rien d'eux."
                     % ", ".join(r["name"] for r in silent))
    lines.append("")
    for row in [target] + controls:
        lines.append("- %-24s %s" % (row["name"], row["verdict"] or "—"))
    lines.append("")
    lines.append("_%s s._" % int(time.time() - started))

    report = "\n".join(lines)

    # Enregistrer si c'est possible ET atteignable, mais l'affichage reste la
    # livraison : sur ce téléphone, le dossier de l'appli est invisible.
    for base in ("/storage/emulated/0/Download", "/sdcard/Download", os.getcwd()):
        try:
            if not os.path.isdir(base):
                continue
            path = os.path.join(base, "rapport-cible.md")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(report)
            print("\nEnregistré : %s" % path, flush=True)
            break
        except Exception:
            continue

    print("")
    print("<<<<<<<<<< DÉBUT DU RAPPORT >>>>>>>>>>")
    print(report)
    print("<<<<<<<<<< FIN DU RAPPORT >>>>>>>>>>")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
