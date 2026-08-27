#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sonde les sites français de solutions de mots fléchés, et dit lesquels sont
intégrables depuis la PWA — sans rien deviner.

Pourquoi ce script existe
-------------------------
L'app veut, pour une définition et un nombre de lettres, retrouver la solution
dans une base existante. Aucun des sites français connus ne publie d'API. La
question n'est donc pas « lequel est le meilleur » mais « lequel est
*atteignable* », et il y a exactement quatre issues, de la meilleure à la pire :

  1. Le site renvoie un en-tête CORS permissif  → la PWA l'appelle directement,
     GitHub Pages suffit, aucun serveur nulle part.
  2. Le site publie un sitemap listant une page par définition → on constitue un
     jeu de données hors-ligne une bonne fois, et GitHub Pages suffit encore.
  3. Le site répond bien mais sans CORS → il faut un relais (Cloud Run…), donc
     un serveur, donc renoncer à la promesse « 100 % local » du README.
  4. Rien de tout ça → le corrigé se saisit à la main.

Le script tranche entre ces quatre issues avec des mesures, pas des suppositions.

Ce qu'il fait, par site
-----------------------
  · joignabilité, latence, encodage, et si le site refuse les agents non-navigateur
  · robots.txt : ce qui est autorisé, le Crawl-delay demandé — et il le respecte
  · sitemap : combien d'URL, à quoi elles ressemblent (issue n° 2)
  · CORS : requête simple avec Origin, puis préflight OPTIONS (issue n° 1)
  · découverte des formulaires de recherche : action, méthode, noms des champs,
    ce qui évite d'inventer des URL qui n'existent pas
  · interrogation réelle sur des définitions dont la réponse est connue d'avance,
    et vérification que cette réponse figure bien dans le HTML reçu
  · extrait du HTML autour de chaque réponse trouvée — de quoi écrire le parseur
  · reniflage d'un éventuel endpoint JSON dans les pages et leurs scripts

Il écrit un rapport Markdown lisible, un JSON complet, et les pages brutes.

Écrit pour être interrompu
--------------------------
Le rapport est réécrit à chaque étape, par fichier temporaire puis renommage :
une veille d'écran ne coûte rien de ce qui a déjà été mesuré, et le fichier
porte un bandeau « partiel » au lieu de se faire passer pour complet. La
relance reprend d'elle-même où le scan s'était arrêté. Et un site qui répond
sans jamais avoir la solution est abandonné au bout de trois essais — ceux qui
ont la réponse la donnent tout de suite, ou une fois sur deux.

Usage
-----
Sur Pydroid 3 : ouvrir le fichier, appuyer sur ▶. Aucun argument n'est requis,
aucune dépendance à installer (bibliothèque standard uniquement). Si l'écran
s'éteint en cours de route, il suffit de rappuyer sur ▶.

En ligne de commande :
    python3 probe-solvers.py                    # scan complet, ~3 min
    python3 probe-solvers.py --only fsolver     # un seul site
    python3 probe-solvers.py --list             # lister les sites
    python3 probe-solvers.py --fresh            # ignorer un rapport précédent
    python3 probe-solvers.py --give-up 0        # ne jamais abandonner un site
    python3 probe-solvers.py --delay 3          # plus poli encore

Politesse
---------
Volume délibérément petit, pause entre chaque requête, robots.txt et son
Crawl-delay respectés par défaut, agent honnête et identifiable. C'est une
évaluation de faisabilité, pas une aspiration de contenu.
"""

from __future__ import annotations

import argparse
import gzip
import html as html_mod
import json
import os
import re
import ssl
import sys
import time
import unicodedata
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest
from urllib.robotparser import RobotFileParser

VERSION = "1.0"

# The origin the PWA would actually call from. CORS answers depend on it, so it
# has to be the real one rather than a placeholder.
ORIGIN = "https://napolocreed.github.io"

# Honest first. A site that refuses this and accepts a browser string is telling
# us something worth putting in the report, so both are tried and recorded.
HONEST_UA = (
    "MotsFlechesProbe/%s (+https://github.com/napolocreed/ocr_crosswords) "
    "evaluation d'integration, faible volume" % VERSION
)
BROWSER_UA = (
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Mobile Safari/537.36"
)

TIMEOUT = 25


# --------------------------------------------------------------------------- #
# Le jeu d'essai
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Probe:
    """Une définition dont on connaît déjà la réponse."""

    clue: str
    length: int
    answers: tuple[str, ...]


# Choisies pour être indiscutables et pour se répartir sur les cas tordus :
# une apostrophe et un accent, une réponse de deux lettres, une réponse longue.
PROBES: tuple[Probe, ...] = (
    Probe("FLEUVE D'ÉGYPTE", 3, ("NIL",)),
    Probe("ASTRE DU JOUR", 6, ("SOLEIL",)),
    Probe("CAPITALE DU JAPON", 5, ("TOKYO",)),
    Probe("NOTE DE MUSIQUE", 2, ("DO", "RE", "MI", "FA", "LA", "SI", "UT")),
)


# --------------------------------------------------------------------------- #
# Les sites
# --------------------------------------------------------------------------- #

@dataclass
class Site:
    id: str
    name: str
    home: str
    # Pages supplémentaires où chercher un formulaire de recherche.
    search_pages: tuple[str, ...] = ()
    # URL candidates écrites à la main. Les placeholders sont documentés dans
    # expand(); celles qui ne mènent nulle part seront simplement signalées.
    templates: tuple[str, ...] = ()
    note: str = ""
    # Renseigné => le site n'est pas interrogé, et le rapport dit pourquoi.
    skip_reason: str = ""


SITES: tuple[Site, ...] = (
    Site(
        id="fsolver",
        name="FSolver",
        home="https://www.fsolver.fr/",
        search_pages=(
            "https://www.fsolver.fr/solution-mots-fleches.php",
            "https://www.fsolver.fr/dictionnaire-mots-croises-gratuit.php",
        ),
        templates=(
            # Mesuré : les deux répondent, sur les quatre définitions. En
            # revanche `/mots-croises/…` renvoie 404 — il n'existe pas.
            "https://www.fsolver.fr/mots-fleches/{star}",
            "https://www.fsolver.fr/mots-fleches/{stars}",
        ),
        note="Annonce ~540 000 mots. Répond aux 4 définitions d'essai, résultats groupés "
             "par longueur. Pas de CORS.",
    ),
    Site(
        id="commeunefleche",
        name="CommeUneFleche",
        home="https://commeunefleche.com/",
        search_pages=(
            "https://commeunefleche.com/-/search",
            "https://commeunefleche.com/solutions-mots-fleches",
        ),
        templates=(
            "https://commeunefleche.com/-/search?q={plus}",
            "https://commeunefleche.com/-/search?s={plus}",
            "https://commeunefleche.com/{slug}",
            "https://commeunefleche.com/{slug}-1",
        ),
        note="Pages rendues par le navigateur : le HTML servi est vide, un fetch n'y verra rien.",
    ),
    Site(
        id="motscroises-fr",
        name="MotsCroises.fr",
        home="https://www.motscroises.fr/",
        templates=(
            "https://www.motscroises.fr/?s={plus}",
            "https://www.motscroises.fr/recherche/{slug}",
        ),
        note="Annonce 80 000 définitions et 540 000 solutions. **Le seul site mesuré qui "
             "renvoie un en-tête CORS couvrant l'origine GitHub Pages** — donc le seul qui "
             "dispenserait d'un serveur. Reste à trouver son URL de recherche : ni formulaire, "
             "ni gabarit deviné n'a fonctionné au premier scan.",
    ),
    Site(
        id="dico-mots",
        name="Dico-Mots",
        home="https://www.dico-mots.fr/mots-croises/",
        search_pages=("https://www.dico-mots.fr/",),
        note="Base collaborative : les définitions viennent des membres.",
    ),
    Site(
        id="mots-croises-ch",
        name="Mots-Croises.ch",
        home="https://www.mots-croises.ch/",
        search_pages=("https://www.mots-croises.ch/Recherche/mots-croises.htm",),
        note="Dictionnaire suisse, noms propres et formes fléchies compris. Répond aux 4 "
             "définitions d'essai via son formulaire, mais ses pages ne portent aucun "
             "marqueur de longueur : la longueur devra se déduire des mots eux-mêmes. "
             "Pas de CORS.",
    ),
    Site(
        id="solutions-mots-fleches",
        name="Solutions-Mots-Fleches",
        home="https://www.solutions-mots-fleches.com/",
        templates=(
            # `/{slug}` d'abord : c'est celui qui a répondu, avec une page très
            # riche en « N lettres ». `?s=` répond 200 mais sans la solution.
            "https://www.solutions-mots-fleches.com/{slug}",
            "https://www.solutions-mots-fleches.com/?s={plus}",
        ),
        note="Une page par définition, pages denses en marqueurs de longueur. Pas de CORS.",
    ),
    Site(
        id="mots-croises-solutions",
        name="Mots-Croises-Solutions",
        home="https://mots-croises-solutions.com/",
        templates=(
            "https://mots-croises-solutions.com/?s={plus}",
            "https://mots-croises-solutions.com/{slug}",
        ),
    ),
    Site(
        id="msolver",
        name="MSolver",
        home="https://msolver.fr/",
        templates=("https://msolver.fr/?s={plus}",),
    ),
    Site(
        id="motsavec",
        name="MotsAvec",
        home="https://motsavec.fr/solution-de-mots-croises-et-mots-fleches",
        search_pages=("https://motsavec.fr/",),
    ),
    Site(
        id="indexsavant",
        name="Index Savant",
        home="https://www.indexsavant.fr/solution-mots-fleches-et-mots-croises",
        search_pages=("https://www.indexsavant.fr/",),
    ),
    Site(
        id="sportcerebral",
        name="Sport Cérébral",
        home="https://www.sportcerebral.com/moteurdemots",
        note="Recherche par motif et longueur ; la définition n'est peut-être pas indexée.",
    ),
    Site(
        id="lemotmalin",
        name="Le Mot Malin",
        home="https://lemotmalin.fr/solveur-mots-fleches/",
        search_pages=("https://lemotmalin.fr/",),
    ),
    Site(
        id="1mot",
        name="1mot.net",
        home="https://1mot.net/",
        note="Surtout un solveur par motif, cité comme alternative à FSolver.",
    ),
    Site(
        id="lerobert",
        name="Le Robert — aide aux mots croisés",
        home="https://jeux.lerobert.com/fr/aide-aux-mots-croises",
        note="Éditeur établi : conditions d'utilisation à lire avant tout usage automatisé.",
    ),
    Site(
        id="wiktionnaire",
        name="Wiktionnaire (API MediaWiki) — témoin CORS",
        home="https://fr.wiktionary.org/w/api.php?action=query&format=json&origin=*&titles=nil",
        note=(
            "Témoin positif. Cette API autorise CORS : si le script ne le détecte pas ICI, "
            "c'est le détecteur qui est en cause, pas les autres sites."
        ),
    ),
    Site(
        id="dcode",
        name="dCode",
        home="https://www.dcode.fr/crossword-solver",
        skip_reason=(
            "Le site refuse explicitement l'accès programmatique : « API access […] are not "
            "public ». Non interrogé — un refus écrit se respecte."
        ),
    ),
)


# --------------------------------------------------------------------------- #
# Petits outils de texte
# --------------------------------------------------------------------------- #

def deaccent(text: str) -> str:
    """« ÉGYPTE » → « EGYPTE ». Les grilles impriment sans accent, les URL aussi."""
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def slugify(text: str) -> str:
    plain = deaccent(text).lower()
    plain = re.sub(r"[^a-z0-9]+", "-", plain)
    return plain.strip("-")


def expand(template: str, probe: Probe) -> str:
    """
    Remplit une URL candidate.

      {q}     définition telle quelle, percent-encodée
      {plus}  idem, espaces en «+»
      {star}  MAJUSCULES sans accent, espaces en «*», apostrophe conservée
      {stars} MAJUSCULES sans accent, toute ponctuation en «*» — l'apostrophe
              aussi, ce qui évite le percent-encodage ; les deux variantes sont
              essayées parce qu'on ignore laquelle chaque site attend
      {slug}  minuscules-avec-des-tirets
      {upper} MAJUSCULES sans accent, espaces percent-encodés
      {len}   nombre de lettres
    """
    upper = deaccent(probe.clue).upper()
    return template.format(
        q=urlparse.quote(probe.clue, safe=""),
        plus=urlparse.quote_plus(probe.clue),
        star=urlparse.quote(upper.replace(" ", "*"), safe="*'"),
        stars=re.sub(r"[^A-Z0-9]+", "*", upper).strip("*"),
        slug=slugify(probe.clue),
        upper=urlparse.quote(upper, safe=""),
        len=probe.length,
    )


TAG_RE = re.compile(r"<[^>]+>")
SCRIPT_RE = re.compile(r"<(script|style|noscript)\b.*?</\1>", re.I | re.S)


def strip_tags(markup: str) -> str:
    text = SCRIPT_RE.sub(" ", markup)
    text = TAG_RE.sub(" ", text)
    return re.sub(r"\s+", " ", html_mod.unescape(text)).strip()


# Les réponses de mots fléchés s'impriment en capitales, accents compris.
TOKEN_RE = re.compile(r"[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]{2,}")


def uppercase_tokens(text: str, length: int) -> list[str]:
    """Mots en capitales de la longueur voulue, dédoublonnés, dans l'ordre d'apparition."""
    seen: list[str] = []
    for token in TOKEN_RE.findall(text):
        plain = deaccent(token)
        if len(plain) == length and plain not in seen:
            seen.append(plain)
    return seen


def find_snippets(markup: str, needle: str, radius: int = 170, limit: int = 3) -> list[str]:
    """
    Extraits du HTML *brut* autour d'une réponse trouvée.

    C'est la partie du rapport qui sert vraiment à écrire le parseur ensuite :
    savoir que « NIL » est dans la page ne dit rien, voir qu'il est dans
    <a class="result" data-len="3">NIL</a> dit tout.
    """
    out: list[str] = []
    covered = 0  # deux occurrences voisines donneraient deux extraits jumeaux
    for match in re.finditer(re.escape(needle), markup, re.I):
        if match.start() < covered:
            continue
        start = max(0, match.start() - radius)
        end = min(len(markup), match.end() + radius)
        covered = end
        out.append(re.sub(r"\s+", " ", markup[start:end]).strip())
        if len(out) >= limit:
            break
    return out


def looks_client_side(markup: str, text: str) -> bool:
    """
    Beaucoup de <script>, presque pas de texte : la page se remplit dans le
    navigateur. Un fetch — direct ou relayé — n'y verra rien, ce qui est une
    raison d'échec très différente de « je n'ai pas trouvé d'URL de recherche ».
    """
    return len(text) < 800 and markup.count("<script") > 3


LENGTH_MARKER_RE = re.compile(r"\b\d{1,2}\s*lettres?\b", re.I)
ENDPOINT_RE = re.compile(
    r"""["'](/[A-Za-z0-9_\-./]*(?:api|search|recherche|solution|ajax|json|query)"""
    r"""[A-Za-z0-9_\-./]*(?:\?[^"']{0,80})?)["']""",
    re.I,
)
SCRIPT_SRC_RE = re.compile(r"<script[^>]+src=[\"']([^\"']+)[\"']", re.I)
LINK_RE = re.compile(r"<a\b[^>]+href=[\"']([^\"'#][^\"']*)[\"']", re.I)

# Trois tirets ou plus, ou un segment très long : ce n'est plus une rubrique,
# c'est une expression transformée en URL — donc probablement une définition.
SLUG_SEG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+){2,}$")


def path_shape(path: str) -> str:
    """
    `/solution/fleuve-d-egypte/3` → `/solution/{slug}/{n}`.

    Un site de solutions a forcément une forme d'URL par définition. La deviner
    de l'extérieur ne marche pas — le premier scan l'a montré : le seul site qui
    autorisait CORS est celui dont je n'ai pas trouvé la recherche. La lire dans
    ses propres liens, si.
    """
    out = []
    for segment in path.strip("/").split("/"):
        if not segment:
            continue
        if segment.isdigit():
            out.append("{n}")
        elif SLUG_SEG_RE.match(segment) or len(segment) > 24:
            out.append("{slug}")
        else:
            out.append(segment)
    return "/" + "/".join(out)


def link_shapes(markup: str, base_url: str, limit: int = 14) -> list[dict]:
    """Formes d'URL internes, les plus fréquentes d'abord, avec un exemple."""
    root = "%s://%s" % urlparse.urlsplit(base_url)[:2]
    counts: dict[str, int] = {}
    examples: dict[str, str] = {}
    for href in LINK_RE.findall(markup):
        absolute = urlparse.urljoin(base_url, href)
        if not absolute.startswith(root):
            continue
        split = urlparse.urlsplit(absolute)
        if not split.path or split.path == "/":
            continue
        shape = path_shape(split.path)
        counts[shape] = counts.get(shape, 0) + 1
        examples.setdefault(shape, absolute)
    ranked = sorted(counts.items(), key=lambda item: -item[1])
    return [{"shape": s, "count": n, "example": examples[s]} for s, n in ranked[:limit]]


def derive_templates(urls: list[str], limit: int = 4) -> list[dict]:
    """
    Transforme des URL observées en gabarits interrogeables.

    Un lien vers `/definition/astre-du-jour` dit tout : le même chemin avec la
    définition qu'on cherche vaut la peine d'être essayé. C'est la seule façon
    honnête de trouver l'URL de recherche d'un site qui n'expose pas de
    formulaire — la deviner de l'extérieur ne marche pas.
    """
    found: dict[str, str] = {}
    for url in urls:
        split = urlparse.urlsplit(url)
        segments = [s for s in split.path.strip("/").split("/") if s]
        for i, segment in enumerate(segments):
            if not (SLUG_SEG_RE.match(segment) or len(segment) > 24):
                continue
            shaped = segments[:]
            shaped[i] = "{slug}"
            template = "%s://%s/%s" % (split.scheme, split.netloc, "/".join(shaped))
            found.setdefault(template, url)
            break
        if len(found) >= limit:
            break
    return [{"template": t, "from": u} for t, u in found.items()]


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

@dataclass
class Resp:
    url: str
    final_url: str = ""
    status: int = 0
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    text: str = ""
    elapsed_ms: int = 0
    error: str = ""
    ua: str = ""
    insecure: bool = False

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 400 and not self.error


def _decode_body(raw: bytes, headers: dict[str, str]) -> str:
    encoding = (headers.get("content-encoding") or "").lower()
    try:
        if "gzip" in encoding:
            raw = gzip.decompress(raw)
        elif "deflate" in encoding:
            raw = zlib.decompress(raw, -zlib.MAX_WBITS)
    except Exception:
        pass  # Un corps mal étiqueté vaut mieux qu'une exception : on l'essaie tel quel.

    charset = ""
    ctype = headers.get("content-type", "")
    match = re.search(r"charset=([\w\-]+)", ctype, re.I)
    if match:
        charset = match.group(1)
    if not charset:
        head = raw[:4096].decode("latin-1", "replace")
        meta = re.search(r"charset=[\"']?([\w\-]+)", head, re.I)
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


def http(
    url: str,
    *,
    method: str = "GET",
    ua: str = HONEST_UA,
    origin: str | None = None,
    extra_headers: dict[str, str] | None = None,
    data: bytes | None = None,
) -> Resp:
    headers = {
        "User-Agent": ua,
        # Pas de « br » : Brotli n'est pas dans la bibliothèque standard.
        "Accept-Encoding": "gzip, deflate",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
    }
    if origin:
        headers["Origin"] = origin
    if extra_headers:
        headers.update(extra_headers)

    request = urlrequest.Request(url, method=method, data=data, headers=headers)
    started = time.time()

    def attempt(context: ssl.SSLContext | None) -> Resp:
        with urlrequest.urlopen(request, timeout=TIMEOUT, context=context) as response:
            body = response.read()
            head = {k.lower(): v for k, v in response.headers.items()}
            return Resp(
                url=url,
                final_url=response.geturl(),
                status=response.status,
                headers=head,
                body=body,
                text=_decode_body(body, head),
                elapsed_ms=int((time.time() - started) * 1000),
                ua=ua,
            )

    try:
        return attempt(None)
    except urlerror.HTTPError as exc:
        # Un 403 ou un 404 portent quand même leurs en-têtes, dont ceux de CORS.
        body = b""
        try:
            body = exc.read()
        except Exception:
            pass
        head = {k.lower(): v for k, v in (exc.headers or {}).items()}
        return Resp(
            url=url,
            final_url=getattr(exc, "url", url) or url,
            status=exc.code,
            headers=head,
            body=body,
            text=_decode_body(body, head),
            elapsed_ms=int((time.time() - started) * 1000),
            error="HTTP %s %s" % (exc.code, exc.reason),
            ua=ua,
        )
    except ssl.SSLError as exc:
        # Android n'a pas toujours le magasin de certificats qu'il faut. On
        # réessaie sans vérification, mais le rapport le dira noir sur blanc.
        try:
            relaxed = ssl.create_default_context()
            relaxed.check_hostname = False
            relaxed.verify_mode = ssl.CERT_NONE
            result = attempt(relaxed)
            result.insecure = True
            return result
        except Exception as inner:
            return Resp(url=url, error="TLS: %s / %s" % (exc, inner), ua=ua,
                        elapsed_ms=int((time.time() - started) * 1000))
    except Exception as exc:
        return Resp(url=url, error="%s: %s" % (type(exc).__name__, exc), ua=ua,
                    elapsed_ms=int((time.time() - started) * 1000))


# --------------------------------------------------------------------------- #
# CORS
# --------------------------------------------------------------------------- #

CORS_HEADERS = (
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-allow-credentials",
    "access-control-max-age",
    "vary",
)


def read_cors(resp: Resp) -> dict[str, str]:
    return {name: resp.headers[name] for name in CORS_HEADERS if name in resp.headers}


def cors_verdict(headers: dict[str, str]) -> tuple[bool, str]:
    allow = headers.get("access-control-allow-origin", "").strip()
    if not allow:
        return False, "aucun en-tête Access-Control-Allow-Origin"
    if allow == "*":
        return True, "Access-Control-Allow-Origin: * — appelable directement"
    if allow.rstrip("/") == ORIGIN.rstrip("/"):
        return True, "Access-Control-Allow-Origin autorise précisément %s" % ORIGIN
    return False, "Access-Control-Allow-Origin: %s — ne couvre pas %s" % (allow, ORIGIN)


# --------------------------------------------------------------------------- #
# Formulaires
# --------------------------------------------------------------------------- #

FORM_RE = re.compile(r"<form\b(?P<attrs>[^>]*)>(?P<inner>.*?)</form>", re.I | re.S)
FIELD_RE = re.compile(r"<(input|select|textarea)\b(?P<attrs>[^>]*)>", re.I)
ATTR_RE = re.compile(r"(\w[\w:-]*)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)")

TEXTUAL = {"", "text", "search", "query"}
LENGTH_NAME_RE = re.compile(r"lettre|nombre|len|taille|caract|size", re.I)


def attrs_of(fragment: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in ATTR_RE.findall(fragment):
        out[name.lower()] = value.strip("\"'")
    return out


@dataclass
class Form:
    action: str
    method: str
    fields: list[dict[str, str]]

    def as_dict(self) -> dict:
        return {
            "action": self.action,
            "method": self.method,
            "fields": [
                {k: v for k, v in f.items() if k in ("tag", "name", "type", "value")}
                for f in self.fields
                if f.get("name")
            ],
        }


def discover_forms(markup: str, base_url: str) -> list[Form]:
    forms: list[Form] = []
    for match in FORM_RE.finditer(markup):
        info = attrs_of(match.group("attrs"))
        fields: list[dict[str, str]] = []
        for tag, field_attrs in FIELD_RE.findall(match.group("inner")):
            entry = attrs_of(field_attrs)
            entry["tag"] = tag.lower()
            fields.append(entry)
        forms.append(
            Form(
                action=urlparse.urljoin(base_url, info.get("action", "") or base_url),
                method=(info.get("method") or "get").lower(),
                fields=fields,
            )
        )
    return forms


def url_from_form(form: Form, probe: Probe) -> tuple[str, dict[str, str]] | None:
    """
    Construit une requête à partir d'un formulaire réellement présent sur la page.

    Bien plus fiable que deviner une URL : on remplit le premier champ texte avec
    la définition, un éventuel champ « nombre de lettres » avec la longueur, et
    on conserve les valeurs par défaut du reste (jetons CSRF compris).
    """
    params: dict[str, str] = {}
    text_field = ""
    for entry in form.fields:
        name = entry.get("name")
        if not name:
            continue
        kind = (entry.get("type") or "").lower()
        if entry["tag"] == "input" and kind in ("submit", "button", "image", "reset"):
            continue
        if entry["tag"] == "input" and kind in ("checkbox", "radio") and "checked" not in entry:
            continue
        if not text_field and entry["tag"] in ("input", "textarea") and kind in TEXTUAL:
            text_field = name
            params[name] = probe.clue
            continue
        if LENGTH_NAME_RE.search(name) and kind in ("number", "text", ""):
            params[name] = str(probe.length)
            continue
        params[name] = entry.get("value", "")
    if not text_field:
        return None
    return form.action, params


# --------------------------------------------------------------------------- #
# Le scan
# --------------------------------------------------------------------------- #

class Scanner:
    def __init__(self, args: argparse.Namespace, sink=None) -> None:
        self.args = args
        self.requests = 0
        self.last_request_at = 0.0
        self.dump_dir = os.path.join(args.out, "dumps")
        self._robots: dict[str, RobotFileParser] = {}
        # `sink` reçoit l'état complet à chaque étape. Sans ça, un téléphone qui
        # se met en veille au bout de dix minutes emporte tout le scan — c'est
        # arrivé deux fois avant que ça n'existe.
        self.sink = sink
        self.done: list[dict] = []
        self.current: dict | None = None

    def say(self, message: str = "") -> None:
        print(message, flush=True)

    def flush(self) -> None:
        """Écrit le rapport tel qu'il est, site en cours compris."""
        if not self.sink:
            return
        rows = list(self.done)
        if self.current is not None:
            rows.append(self.current)
        try:
            self.sink(rows)
        except Exception as exc:  # ne jamais faire tomber le scan sur une écriture
            self.say("    ⚠️ écriture du rapport impossible : %s" % exc)

    def commit(self) -> None:
        """Clôt le site en cours et l'enregistre."""
        if self.current is not None:
            self.done.append(self.current)
            self.current = None
        self.flush()

    def wait(self, extra: float = 0.0) -> None:
        delay = max(self.args.delay, extra)
        elapsed = time.time() - self.last_request_at
        if self.last_request_at and elapsed < delay:
            time.sleep(delay - elapsed)

    def get(self, url: str, *, crawl_delay: float = 0.0, **kwargs) -> Resp:
        self.wait(crawl_delay)
        self.requests += 1
        resp = http(url, **kwargs)
        self.last_request_at = time.time()
        return resp

    # -- robots ------------------------------------------------------------- #

    def read_robots(self, site: Site) -> dict:
        root = "%s://%s" % urlparse.urlsplit(site.home)[:2]
        resp = self.get(root + "/robots.txt")
        info: dict = {
            "url": root + "/robots.txt",
            "status": resp.status,
            "error": resp.error,
            "crawl_delay": 0.0,
            "sitemaps": [],
            "allows_home": True,
            "raw_excerpt": "",
        }
        if not resp.ok or not resp.text.strip():
            return info

        info["raw_excerpt"] = resp.text[:900]
        parser = RobotFileParser()
        parser.parse(resp.text.splitlines())
        try:
            info["allows_home"] = parser.can_fetch("*", site.home)
        except Exception:
            info["allows_home"] = True
        delay = parser.crawl_delay("*")
        if delay:
            info["crawl_delay"] = float(delay)
        info["sitemaps"] = [
            line.split(":", 1)[1].strip()
            for line in resp.text.splitlines()
            if line.lower().startswith("sitemap:")
        ]
        self._robots[site.id] = parser
        return info

    def allowed(self, site: Site, url: str) -> bool:
        if self.args.ignore_robots:
            return True
        parser = self._robots.get(site.id)
        if not parser:
            return True
        try:
            return parser.can_fetch("*", url)
        except Exception:
            return True

    # -- sitemap ------------------------------------------------------------ #

    def read_sitemap(self, url: str, crawl_delay: float) -> dict:
        """
        Taille et forme d'un sitemap. On ne le déroule pas : ce qui compte à ce
        stade est de savoir s'il existe une page par définition, donc si la base
        est énumérable — l'issue qui garderait tout sur GitHub Pages.
        """
        resp = self.get(url, crawl_delay=crawl_delay)
        info = {"url": url, "status": resp.status, "error": resp.error,
                "is_index": False, "count": 0, "samples": []}
        if not resp.ok:
            return info
        body = resp.body
        if url.endswith(".gz") or body[:2] == b"\x1f\x8b":
            try:
                body = gzip.decompress(body)
            except Exception:
                pass
        text = body.decode("utf-8", "replace")
        locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", text)
        info["is_index"] = "<sitemapindex" in text
        info["count"] = len(locs)
        info["samples"] = locs[:8]
        info["all"] = locs
        return info

    def explore_sitemaps(self, site: Site, robots: dict, crawl_delay: float) -> list[dict]:
        """
        Descend d'un cran dans un index de sitemaps.

        S'arrêter à l'index ne dit rien : « 18 URL » sur motscroises.fr, ce sont
        dix-huit sous-sitemaps, pas dix-huit pages. Le compte réel de la base et
        la forme de ses URL sont un niveau plus bas — et c'est justement ce qu'il
        faut pour interroger un site qui n'expose aucun formulaire.
        """
        root = "%s://%s" % urlparse.urlsplit(site.home)[:2]
        roots = list(robots["sitemaps"]) or [root + "/sitemap.xml"]
        out: list[dict] = []
        budget = self.args.max_sitemaps
        for url in roots[: self.args.max_sitemaps]:
            info = self.read_sitemap(url, crawl_delay)
            out.append(info)
            if info["count"]:
                self.say("    %s : %s URL%s" % (
                    url, info["count"], " (index de sitemaps)" if info["is_index"] else ""))
            if not info["is_index"]:
                continue
            for child in info.get("all", [])[:budget]:
                if not self.allowed(site, child):
                    continue
                sub = self.read_sitemap(child, crawl_delay)
                sub["parent"] = url
                out.append(sub)
                budget -= 1
                if sub["count"]:
                    self.say("      ↳ %s : %s URL" % (child.rsplit("/", 1)[-1], sub["count"]))
                if budget <= 0:
                    break
            if budget <= 0:
                break
        # La liste complète a servi à descendre ; la garder mettrait des milliers
        # d'URL dans le rapport, que personne ne lira.
        for info in out:
            info.pop("all", None)
        return out

    # -- le corps du scan --------------------------------------------------- #

    def scan(self, site: Site) -> dict:
        self.say("")
        self.say("=" * 68)
        self.say("  %s  (%s)" % (site.name, site.id))
        self.say("=" * 68)

        # `url` est l'adresse de départ, `home` le compte rendu de la réponse.
        # Les confondre sous une seule clé ferait tenir tantôt une chaîne,
        # tantôt un dictionnaire — de quoi faire tomber le rapport un jour.
        report: dict = {
            "id": site.id,
            "name": site.name,
            "url": site.home,
            "note": site.note,
            "skipped": bool(site.skip_reason),
            "skip_reason": site.skip_reason,
            # Passe à True à la toute fin. Une reprise ne réutilise que les
            # sites complets : un site coupé en plein vol doit être refait.
            "complete": False,
        }
        # Publié tout de suite : si l'appareil s'éteint pendant la première
        # requête, le rapport dira au moins quel site était en cours.
        self.current = report
        self.flush()
        if site.skip_reason:
            self.say("  ignoré — %s" % site.skip_reason)
            report["complete"] = True
            return report

        # 1. joignabilité, et refus éventuel des agents non-navigateur
        self.say("  · joignabilité…")
        home = self.get(site.home, origin=ORIGIN)
        report["ua_blocked"] = False
        # Uniquement sur un vrai code HTTP de refus : une panne de transport ne
        # se règle pas en changeant d'agent, et réessayer doublerait les
        # requêtes de tout le scan quand le téléphone est simplement hors ligne.
        if home.status in (401, 403, 406, 429):
            self.say("    %s avec l'agent honnête — nouvel essai en agent navigateur"
                     % (home.error or home.status))
            retry = self.get(site.home, origin=ORIGIN, ua=BROWSER_UA)
            if retry.ok:
                report["ua_blocked"] = True
                home = retry

        report["home"] = self._summarise(home)
        if not home.ok:
            self.say("    injoignable : %s" % (home.error or home.status))
            report["complete"] = True
            return report
        size = len(home.body)
        self.say("    %s en %s ms, %s%s%s" % (
            home.status, home.elapsed_ms,
            "%s Ko" % (size // 1024) if size >= 1024 else "%s octets" % size,
            " (TLS non vérifié)" if home.insecure else "",
            " — page vide, rendue côté navigateur" if report["home"]["likely_client_side"] else "",
        ))

        ua = BROWSER_UA if report["ua_blocked"] else HONEST_UA

        # 2. robots.txt
        self.say("  · robots.txt…")
        robots = self.read_robots(site)
        report["robots"] = robots
        crawl_delay = robots["crawl_delay"]
        if crawl_delay:
            self.say("    Crawl-delay %.1fs demandé — respecté" % crawl_delay)
        if not robots["allows_home"]:
            self.say("    robots.txt interdit cette zone aux robots")

        # 3. sitemap — la piste « base énumérable hors-ligne », et la forme des URL
        report["sitemaps"] = []
        if self.args.sitemap:
            self.say("  · sitemap…")
            report["sitemaps"] = self.explore_sitemaps(site, robots, crawl_delay)

        # 4. CORS — la question décisive
        self.say("  · CORS…")
        simple = read_cors(home)
        allowed_by_cors, why = cors_verdict(simple)
        preflight = self.get(
            site.home, method="OPTIONS", origin=ORIGIN, ua=ua,
            extra_headers={"Access-Control-Request-Method": "GET"},
            crawl_delay=crawl_delay,
        )
        report["cors"] = {
            "simple": simple,
            "simple_ok": allowed_by_cors,
            "verdict": why,
            "preflight_status": preflight.status,
            "preflight": read_cors(preflight),
        }
        self.say("    %s" % why)
        self.flush()  # le verdict décisif est acquis : il ne doit plus se perdre

        # 5. formulaires de recherche
        self.say("  · formulaires…")
        forms: list[Form] = discover_forms(home.text, home.final_url or site.home)
        pages_scanned = [site.home]
        # Gardé pour la récolte de liens plus bas : une page « recherche » porte
        # souvent des exemples de définitions que l'accueil n'a pas.
        harvested: list[tuple[str, str]] = [(home.final_url or site.home, home.text)]
        for page in site.search_pages:
            if not self.allowed(site, page):
                continue
            resp = self.get(page, ua=ua, crawl_delay=crawl_delay)
            if resp.ok:
                pages_scanned.append(page)
                forms.extend(discover_forms(resp.text, resp.final_url or page))
                harvested.append((resp.final_url or page, resp.text))
        usable_forms = [f for f in forms if url_from_form(f, PROBES[0])]
        report["forms"] = [f.as_dict() for f in forms]
        report["pages_scanned"] = pages_scanned
        self.say("    %s formulaire(s), dont %s exploitable(s)" % (len(forms), len(usable_forms)))

        # 5b. la forme des URL du site, lue dans ses liens et son sitemap, puis
        # transformée en gabarits — le rattrapage des sites sans formulaire.
        merged: dict[str, dict] = {}
        for page_url, markup in harvested:
            for row in link_shapes(markup, page_url):
                current = merged.setdefault(row["shape"], {**row, "count": 0})
                current["count"] += row["count"]
        report["link_shapes"] = sorted(merged.values(), key=lambda row: -row["count"])[:14]
        observed = [row["example"] for row in report["link_shapes"]]
        for info in report.get("sitemaps", []):
            if not info.get("is_index"):
                observed.extend(info.get("samples", []))
        report["derived"] = derive_templates(observed)
        if report["derived"]:
            self.say("    %s gabarit(s) déduit(s) des URL du site" % len(report["derived"]))
            for row in report["derived"]:
                self.say("      %s" % urlparse.urlsplit(row["template"]).path)

        # 6. endpoints JSON éventuels
        if self.args.deep:
            self.say("  · scripts…")
            report["endpoints"] = self._sniff_endpoints(site, home, ua, crawl_delay)
            if report["endpoints"]:
                self.say("    %s piste(s) d'endpoint" % len(report["endpoints"]))

        # 7. interrogations réelles
        self.say("  · interrogations…")
        report["queries"] = self._run_queries(
            site, usable_forms, ua, crawl_delay, report["derived"])
        report["complete"] = True
        return report

    # -- sous-étapes -------------------------------------------------------- #

    def _summarise(self, resp: Resp) -> dict:
        return {
            "url": resp.url,
            "final_url": resp.final_url,
            "status": resp.status,
            "error": resp.error,
            "elapsed_ms": resp.elapsed_ms,
            "bytes": len(resp.body),
            "server": resp.headers.get("server", ""),
            "content_type": resp.headers.get("content-type", ""),
            "tls_unverified": resp.insecure,
            "likely_client_side": looks_client_side(resp.text, strip_tags(resp.text)),
        }

    def _sniff_endpoints(self, site: Site, home: Resp, ua: str, crawl_delay: float) -> list[str]:
        found: list[str] = []
        for path in ENDPOINT_RE.findall(home.text):
            if path not in found:
                found.append(path)
        root = "%s://%s" % urlparse.urlsplit(site.home)[:2]
        scripts = [
            urlparse.urljoin(home.final_url or site.home, src)
            for src in SCRIPT_SRC_RE.findall(home.text)
        ]
        same_origin = [s for s in scripts if s.startswith(root)][: self.args.max_scripts]
        for src in same_origin:
            if not self.allowed(site, src):
                continue
            resp = self.get(src, ua=ua, crawl_delay=crawl_delay)
            if not resp.ok:
                continue
            for path in ENDPOINT_RE.findall(resp.text[:400_000]):
                if path not in found:
                    found.append(path)
        return found[:40]

    def _run_queries(self, site: Site, forms: list[Form], ua: str, crawl_delay: float,
                     derived: list[dict] | None = None) -> list[dict]:
        results: list[dict] = []
        # Un site qui a la réponse la donne tout de suite, ou une fois sur deux ;
        # un site qui en enchaîne trois sans rien n'en a pas. Insister coûte des
        # minutes à chaque site muet, et il y en a plus que de sites utiles.
        misses = 0
        hits = 0
        # Sauf s'il autorise CORS. Celui-là est le seul qui puisse dispenser
        # d'un serveur : l'abandonner faute d'avoir trouvé son URL de recherche,
        # c'est renoncer au meilleur résultat possible pour une économie de
        # quelques secondes. C'est exactement ce qui s'est produit au premier
        # scan sur motscroises.fr.
        cors_ok = bool((self.current or {}).get("cors", {}).get("simple_ok"))
        if cors_ok:
            self.say("    (CORS ouvert : ce site est exploré jusqu'au bout)")

        for probe in PROBES[: self.args.probes]:
            attempts: list[tuple[str, str, dict[str, str] | None]] = []
            for template in site.templates:
                # Le gabarit lui-même, pas juste « gabarit » : savoir que c'est
                # `/mots-fleches/{stars}` qui répond, et pas `/{star}`, c'est
                # exactement ce qu'il faudra recopier dans l'app.
                label = "gabarit `%s`" % (urlparse.urlsplit(template).path or template)
                attempts.append((label, expand(template, probe), None))
            for row in derived or []:
                label = "déduit `%s`" % urlparse.urlsplit(row["template"]).path
                attempts.append((label, expand(row["template"], probe), None))
            for form in forms[: self.args.max_forms]:
                built = url_from_form(form, probe)
                if not built:
                    continue
                action, params = built
                query = urlparse.urlencode(params)
                joiner = "&" if "?" in action else "?"
                attempts.append(("formulaire %s" % form.method.upper(),
                                 action + joiner + query, params if form.method == "post" else None))

            hit_for_this_probe = False
            for origin_label, url, post_params in attempts:
                if hit_for_this_probe and not self.args.exhaustive:
                    break
                if not self.allowed(site, url):
                    results.append({
                        "clue": probe.clue, "length": probe.length, "url": url,
                        "via": origin_label, "skipped": "interdit par robots.txt",
                    })
                    self.say("    ⨯ %s — interdit par robots.txt" % url[:78])
                    continue

                if post_params is not None:
                    base = url.split("?")[0]
                    resp = self.get(
                        base, method="POST", ua=ua, origin=ORIGIN, crawl_delay=crawl_delay,
                        data=urlparse.urlencode(post_params).encode(),
                        extra_headers={"Content-Type": "application/x-www-form-urlencoded"},
                    )
                else:
                    resp = self.get(url, ua=ua, origin=ORIGIN, crawl_delay=crawl_delay)

                entry = self._judge(probe, resp, origin_label)
                results.append(entry)
                mark = "✓" if entry["found"] else ("·" if resp.ok else "⨯")
                self.say("    %s [%s] %s → %s" % (
                    mark, probe.length, probe.clue[:26].ljust(26),
                    entry["summary"],
                ))
                if entry["found"]:
                    hits += 1
                    hit_for_this_probe = True
                    if self.args.dump:
                        self._dump(site, probe, resp)
                else:
                    misses += 1

                # Une seule réussite suffit à racheter le site : on ne l'abandonne
                # plus, on va au bout pour en tirer tout ce qu'on peut.
                if hits == 0 and self.args.give_up and misses >= self.args.give_up and not cors_ok:
                    reason = "abandonné après %s essai%s sans résultat" % (
                        misses, "s" if misses > 1 else "")
                    self.say("    ⏭  %s — on passe au suivant" % reason)
                    if self.current is not None:
                        self.current["abandoned"] = reason
                    return results
            # Le site en cours est réécrit sur le disque après chaque définition.
            self.flush()
        return results

    def _judge(self, probe: Probe, resp: Resp, via: str) -> dict:
        entry: dict = {
            "clue": probe.clue,
            "length": probe.length,
            "expected": list(probe.answers),
            "via": via,
            "url": resp.final_url or resp.url,
            "status": resp.status,
            "error": resp.error,
            "elapsed_ms": resp.elapsed_ms,
            "bytes": len(resp.body),
            "cors": read_cors(resp),
            "found": False,
            "matched": [],
            "candidates": [],
            "length_markers": 0,
            "snippets": [],
            "likely_client_side": False,
            "summary": "",
        }
        if not resp.ok:
            entry["summary"] = "échec — %s" % (resp.error or resp.status)
            return entry

        text = strip_tags(resp.text)
        entry["candidates"] = uppercase_tokens(text, probe.length)[:40]
        entry["length_markers"] = len(LENGTH_MARKER_RE.findall(text))
        entry["likely_client_side"] = looks_client_side(resp.text, text)

        plain = deaccent(text).upper()
        for answer in probe.answers:
            if re.search(r"\b%s\b" % re.escape(answer), plain):
                entry["matched"].append(answer)
                entry["snippets"].extend(find_snippets(resp.text, answer))
        entry["found"] = bool(entry["matched"])
        entry["snippets"] = entry["snippets"][:4]

        if entry["found"]:
            count = len(entry["candidates"])
            entry["summary"] = "trouvé %s (%s mot%s de %s lettres, %s mention%s de longueur)" % (
                "/".join(entry["matched"]), count, "s" if count > 1 else "",
                probe.length, entry["length_markers"],
                "s" if entry["length_markers"] > 1 else "",
            )
        elif entry["likely_client_side"]:
            entry["summary"] = "page vide côté serveur — rendue par le navigateur"
        else:
            entry["summary"] = "%s, réponse absente du HTML (%s mots de %s lettres)" % (
                resp.status, len(entry["candidates"]), probe.length,
            )
        return entry

    def _dump(self, site: Site, probe: Probe, resp: Resp) -> None:
        os.makedirs(self.dump_dir, exist_ok=True)
        name = "%s-%s.html" % (site.id, slugify(probe.clue))
        path = os.path.join(self.dump_dir, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("<!-- %s -->\n" % (resp.final_url or resp.url))
            handle.write(resp.text[: self.args.dump_bytes])


# --------------------------------------------------------------------------- #
# Le rapport
# --------------------------------------------------------------------------- #

def classify(report: dict) -> tuple[str, str]:
    """(issue, phrase) — voir les quatre issues décrites en tête de fichier."""
    if report.get("skipped"):
        return "exclu", report.get("skip_reason", "")
    home = report.get("home")
    if not isinstance(home, dict):
        home = {}
    if not home or not (200 <= home.get("status", 0) < 400):
        return "injoignable", "le site n'a pas répondu (%s)" % (
            home.get("error") or home.get("status") or "aucune réponse")

    queries = report.get("queries") or []
    hits = [q for q in queries if q.get("found")]
    cors_ok = bool(report.get("cors", {}).get("simple_ok"))
    hit_with_cors = [q for q in hits if cors_verdict(q.get("cors", {}))[0]]

    # Seulement les feuilles : « 18 URL » sur un index, ce sont dix-huit
    # sous-sitemaps, pas dix-huit pages, et les compter tromperait le verdict.
    sitemap_total = sum(s.get("count", 0) for s in report.get("sitemaps", [])
                        if not s.get("is_index"))

    if hit_with_cors or (hits and cors_ok):
        return "direct", "répond aux définitions ET autorise CORS : appelable depuis GitHub Pages"
    if hits:
        note = "répond aux définitions, mais sans CORS : il faut un relais"
        if sitemap_total > 1000:
            note += " — ou un sitemap de %s URL à moissonner une fois" % sitemap_total
        return "relais", note
    # Avant « pas de recherche » : une page vide côté serveur explique à elle
    # seule qu'on n'ait trouvé ni formulaire ni résultat.
    if home.get("likely_client_side") or any(q.get("likely_client_side") for q in queries):
        return "js", "pages rendues côté navigateur : un simple fetch ne verra rien"
    if not queries:
        return "sans-requête", "aucune URL de recherche exploitable trouvée"
    # Dit franchement que le site n'a pas été exploré jusqu'au bout : un verdict
    # tiré de trois essais ne vaut pas un verdict tiré de tous.
    if report.get("abandoned"):
        return "sans-réponse", report["abandoned"] + " — exploration écourtée"
    return "sans-réponse", "répond, mais aucune des réponses attendues n'apparaît dans le HTML"


BADGE = {
    "direct": "✅ direct",
    "relais": "🟠 relais requis",
    "js": "🔵 rendu JS",
    "sans-réponse": "⚪ sans résultat",
    "sans-requête": "⚪ pas de recherche",
    "injoignable": "❌ injoignable",
    "exclu": "🚫 exclu",
}


def markdown(reports: list[dict], meta: dict) -> str:
    lines: list[str] = []
    add = lines.append

    add("# Rapport de sondage — solutions de mots fléchés")
    add("")
    add("- Généré le %s" % meta["when"])
    add("- Origine testée pour CORS : `%s`" % ORIGIN)
    add("- %s requêtes, %s s d'attente entre chacune" % (meta["requests"], meta["delay"]))
    add("- Python %s sur %s" % (meta["python"], meta["platform"]))
    add("")
    if meta.get("partial"):
        finished = sum(1 for r in reports if r.get("complete"))
        add("> ⏳ **Rapport partiel** — %s site(s) sur %s menés à terme. Le scan a été "
            "interrompu, ou tourne encore. Relance le script : il reprendra où il s'est "
            "arrêté et complétera ce fichier."
            % (finished, meta.get("expected", len(reports))))
        add("")

    verdicts = {r["id"]: classify(r) for r in reports}

    add("## Verdict")
    add("")
    add("| Site | Issue | Détail |")
    add("| --- | --- | --- |")
    for report in reports:
        kind, why = verdicts[report["id"]]
        add("| %s | %s | %s |" % (report["name"], BADGE.get(kind, kind), why))
    add("")

    direct = [r for r in reports if verdicts[r["id"]][0] == "direct" and r["id"] != "wiktionnaire"]
    relais = [r for r in reports if verdicts[r["id"]][0] == "relais"]
    enumerable = [
        r for r in reports
        if sum(s.get("count", 0) for s in r.get("sitemaps", [])) > 1000
    ]
    control = next((r for r in reports if r["id"] == "wiktionnaire"), None)

    add("## Ce qu'il faut en conclure")
    add("")
    probed = [r for r in reports if not r.get("skipped")]
    offline = bool(probed) and all(verdicts[r["id"]][0] == "injoignable" for r in probed)
    if offline:
        add("- ⚠️ **Aucun site n'a répondu.** Ce n'est pas un verdict sur les sites : c'est "
            "l'appareil qui n'a pas de route vers l'extérieur (pas de réseau, pare-feu, VPN, "
            "proxy d'entreprise). Relance depuis une connexion ouverte — en l'état ce rapport "
            "ne prouve rien.")
    if not offline:
        if control:
            kind, _ = verdicts["wiktionnaire"]
            add("- **Témoin CORS** — le Wiktionnaire, qui autorise CORS, est classé « %s ». %s"
                % (BADGE.get(kind, kind),
                   "Le détecteur fonctionne." if control.get("cors", {}).get("simple_ok")
                   else "⚠️ Le détecteur n'a rien vu là où il aurait dû : les autres verdicts "
                        "CORS sont à considérer comme non concluants."))
        if direct:
            add("- **Un site est appelable directement** (%s). La PWA peut rester sur GitHub "
                "Pages, sans serveur : voir les extraits HTML plus bas pour écrire le parseur."
                % ", ".join(r["name"] for r in direct))
        elif enumerable:
            add("- **Aucun site appelable directement**, mais %s expose(nt) un sitemap assez gros "
                "pour constituer un jeu de données hors-ligne une bonne fois. GitHub Pages reste "
                "possible." % ", ".join(r["name"] for r in enumerable))
        elif relais:
            add("- **Aucun site appelable directement.** %s répond(ent) correctement, mais il "
                "faudra un relais côté serveur (Cloud Run) — donc renoncer à « aucun serveur »."
                % ", ".join(r["name"] for r in relais))
        else:
            add("- **Aucune source exploitable automatiquement.** Le corrigé devra être saisi "
                "ou importé.")
    add("")

    add("## Détail par site")
    add("")
    for report in reports:
        kind, why = verdicts[report["id"]]
        add("### %s — %s" % (report["name"], BADGE.get(kind, kind)))
        add("")
        if report.get("note"):
            add("> %s" % report["note"])
            add("")
        if report.get("skipped"):
            add("Non interrogé : %s" % report["skip_reason"])
            add("")
            continue

        home = report.get("home")
        if not isinstance(home, dict) or not home:
            add("Aucune donnée : %s" % report.get("error", "le sondage n'a rien renvoyé"))
            add("")
            continue

        add("- URL : `%s`" % (home.get("final_url") or home.get("url", "")))
        add("- Réponse : %s en %s ms, %s octets, `%s`" % (
            home.get("status"), home.get("elapsed_ms"), home.get("bytes"),
            home.get("content_type", "")))
        if home.get("tls_unverified"):
            add("- ⚠️ Certificat TLS non vérifiable depuis cet appareil — résultat à confirmer.")
        if report.get("ua_blocked"):
            add("- Refuse les agents non-navigateur ; sondé avec un agent Chrome.")
        if home.get("likely_client_side"):
            add("- Page d'accueil quasi vide côté serveur : contenu injecté par JavaScript.")
        if report.get("abandoned"):
            add("- ⏭ **%s** : toutes les définitions n'ont pas été essayées sur ce site."
                % report["abandoned"])
        if not report.get("complete"):
            add("- ⏳ Sondage inachevé sur ce site — il sera refait à la prochaine relance.")

        robots = report.get("robots", {})
        if robots:
            add("- robots.txt : %s%s%s" % (
                robots.get("status"),
                "" if robots.get("allows_home", True) else " — **interdit cette zone**",
                ", Crawl-delay %.1fs" % robots["crawl_delay"] if robots.get("crawl_delay") else "",
            ))
        sitemaps = [s for s in report.get("sitemaps", []) if s.get("count")]
        leaves = sum(s["count"] for s in sitemaps if not s.get("is_index"))
        for sitemap in sitemaps:
            indent = "  " if sitemap.get("parent") else ""
            add("%s- Sitemap `%s` : %s URL%s" % (
                indent, sitemap["url"], sitemap["count"],
                " (index de sitemaps)" if sitemap.get("is_index") else ""))
            for sample in sitemap.get("samples", [])[:3]:
                add("%s  - `%s`" % (indent, sample))
        if leaves:
            add("- **%s page(s)** atteintes par les sitemaps explorés%s." % (
                leaves,
                " — la base peut donc se moissonner une fois pour toutes"
                if leaves > 1000 else ""))

        cors = report.get("cors", {})
        if cors:
            add("- CORS : %s" % cors.get("verdict", ""))
            if cors.get("simple"):
                for name, value in cors["simple"].items():
                    add("  - `%s: %s`" % (name, value))
            add("  - préflight OPTIONS → %s" % cors.get("preflight_status"))

        forms = report.get("forms") or []
        if forms:
            add("- Formulaires trouvés :")
            for form in forms[:6]:
                names = ", ".join(
                    "`%s`%s" % (f.get("name"), "=%s" % f["value"] if f.get("value") else "")
                    for f in form.get("fields", [])[:8]
                )
                add("  - `%s %s` → %s" % (form["method"].upper(), form["action"], names or "—"))

        shapes = report.get("link_shapes") or []
        if shapes:
            add("- Formes d'URL internes, par fréquence :")
            for row in shapes[:10]:
                add("  - `%s` ×%s — ex. `%s`" % (row["shape"], row["count"], row["example"]))

        derived = report.get("derived") or []
        if derived:
            add("- Gabarits déduits de ces URL et essayés :")
            for row in derived:
                add("  - `%s` (d'après `%s`)" % (row["template"], row["from"]))

        endpoints = report.get("endpoints") or []
        if endpoints:
            add("- Pistes d'endpoint repérées dans le JS :")
            for path in endpoints[:10]:
                add("  - `%s`" % path)

        queries = report.get("queries") or []
        if queries:
            add("")
            add("| Définition | Lg | Via | Statut | Résultat |")
            add("| --- | --- | --- | --- | --- |")
            for query in queries:
                if query.get("skipped"):
                    add("| %s | %s | %s | — | %s |" % (
                        query["clue"], query["length"], query.get("via", ""), query["skipped"]))
                    continue
                add("| %s | %s | %s | %s | %s |" % (
                    query["clue"], query["length"], query.get("via", ""),
                    query.get("status"), query.get("summary", "")))

            for query in queries:
                if not query.get("snippets"):
                    continue
                add("")
                add("**Extraits HTML — %s → %s** (`%s`)" % (
                    query["clue"], "/".join(query["matched"]), query["url"]))
                add("")
                add("```html")
                for snippet in query["snippets"]:
                    add(snippet[:600])
                    add("")
                add("```")
                candidates = query.get("candidates") or []
                if candidates:
                    add("Mots de %s lettres relevés dans la page : %s" % (
                        query["length"], ", ".join(candidates[:25])))
        add("")

    add("---")
    add("")
    add("_Rapport produit par `scripts/probe-solvers.py` v%s._" % VERSION)
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Entrée
# --------------------------------------------------------------------------- #

OUT_FOLDER = "sonde-mots-fleches"


def on_android() -> bool:
    return bool(os.environ.get("ANDROID_ROOT") or os.environ.get("ANDROID_DATA")) or any(
        os.path.isdir(path) for path in ("/storage/emulated/0", "/sdcard"))


def writable(path: str) -> bool:
    try:
        os.makedirs(path, exist_ok=True)
        witness = os.path.join(path, ".probe-write-test")
        with open(witness, "w") as handle:
            handle.write("ok")
        os.remove(witness)
        return True
    except Exception:
        return False


SHARED_ANDROID_DIRS = (
    "/storage/emulated/0/Download", "/sdcard/Download",
    "/storage/emulated/0/Documents", "/storage/emulated/0", "/sdcard",
)


def out_candidates(android: bool, here: str) -> list[str]:
    """
    Les dossiers de sortie, du plus souhaitable au dernier recours.

    Sur Android le stockage partagé passe **avant** le dossier du script, et
    c'est tout l'enjeu : celui du script est celui de Pydroid,
    `/data/user/0/ru.iiec.pydroid3/files`, parfaitement inscriptible et
    parfaitement invisible depuis le gestionnaire de fichiers. Un premier
    rapport y a été écrit puis perdu faute de pouvoir l'atteindre.
    """
    fallbacks = [here, os.path.expanduser("~"), os.getcwd()]
    if not android:
        return fallbacks
    # Un sous-dossier nommé, pour qu'il se retrouve au milieu des téléchargements.
    return [os.path.join(base, OUT_FOLDER) for base in SHARED_ANDROID_DIRS] + fallbacks


def is_private_android_dir(path: str) -> bool:
    """Le dossier privé d'une appli Android : inscriptible, mais inatteignable."""
    return path.startswith("/data/")


def default_out() -> str:
    here = os.path.dirname(os.path.abspath(sys.argv[0] or "."))
    for candidate in out_candidates(on_android(), here):
        # Ne pas créer `/sdcard/…` sur une machine qui n'en a pas : le parent
        # doit déjà exister pour que le candidat soit pris au sérieux.
        parent = os.path.dirname(candidate.rstrip("/"))
        if parent and not os.path.isdir(parent):
            continue
        if writable(candidate):
            return candidate
    return os.getcwd()


def load_previous(json_path: str) -> list[dict]:
    """
    Le rapport d'un run précédent, s'il est réutilisable.

    Un rapport produit par une autre version du script est ignoré sans bruit :
    reprendre sur des mesures faites par un code différent donnerait un rapport
    mi-figue mi-raisin, impossible à interpréter.
    """
    try:
        with open(json_path, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return []
    if (data.get("meta") or {}).get("version") != VERSION:
        return []
    sites = data.get("sites")
    return sites if isinstance(sites, list) else []


def order_by(chosen: list[Site], rows: list[dict]) -> list[dict]:
    """Remet les sites dans l'ordre de la liste, dédoublonnés, reprise comprise."""
    rank = {site.id: i for i, site in enumerate(chosen)}
    latest: dict[str, dict] = {}
    for row in rows:
        latest[row.get("id", "")] = row
    return sorted(latest.values(), key=lambda row: rank.get(row.get("id", ""), 10_000))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Sonde les sites français de solutions de mots fléchés.",
    )
    parser.add_argument("--only", default="", help="ids séparés par des virgules")
    parser.add_argument("--skip", default="", help="ids à écarter")
    parser.add_argument("--list", action="store_true", help="lister les sites et sortir")
    parser.add_argument("--delay", type=float, default=0.5, help="pause entre requêtes (s)")
    parser.add_argument("--probes", type=int, default=len(PROBES), help="nombre de définitions")
    parser.add_argument("--give-up", type=int, default=3, metavar="N",
                        help="abandonner un site après N interrogations sans résultat "
                             "(0 = ne jamais abandonner)")
    parser.add_argument("--fresh", action="store_true",
                        help="repartir de zéro au lieu de reprendre un rapport interrompu")
    parser.add_argument("--first-hit", dest="exhaustive", action="store_false",
                        help="s'arrêter à la première URL qui répond, au lieu de "
                             "toutes les essayer (scan plus court, rapport plus pauvre)")
    parser.add_argument("--no-sitemap", dest="sitemap", action="store_false",
                        help="ne pas regarder les sitemaps")
    parser.add_argument("--no-deep", dest="deep", action="store_false",
                        help="ne pas lire les scripts à la recherche d'endpoints")
    parser.add_argument("--no-dump", dest="dump", action="store_false",
                        help="ne pas enregistrer les pages brutes")
    parser.add_argument("--dump-bytes", type=int, default=300_000)
    parser.add_argument("--max-forms", type=int, default=3)
    parser.add_argument("--max-scripts", type=int, default=4)
    parser.add_argument("--max-sitemaps", type=int, default=3)
    parser.add_argument("--ignore-robots", action="store_true",
                        help="ne pas tenir compte de robots.txt (déconseillé)")
    parser.add_argument("--out", default="", help="dossier de sortie")
    parser.add_argument("--print", "--print-report", dest="print_report", action="store_true",
                        help="afficher le rapport entier dans le terminal à la fin, pour "
                             "pouvoir le copier quand le fichier n'est pas atteignable")
    args = parser.parse_args(argv)

    if args.list:
        for site in SITES:
            print("%-24s %s%s" % (site.id, site.home,
                                  "   [exclu]" if site.skip_reason else ""))
        return 0

    args.out = args.out or default_out()
    os.makedirs(args.out, exist_ok=True)

    # Un rapport écrit dans le dossier privé de l'appli n'existe pas pour son
    # lecteur : Android ne le montre nulle part. Mieux vaut le dire tout de
    # suite que de le laisser découvrir le scan terminé.
    unreachable = is_private_android_dir(args.out)
    if unreachable:
        # Et on l'affiche d'office. Sur un téléphone on appuie sur ▶, on ne passe
        # pas d'options : compter sur un drapeau que le lecteur ne peut pas taper
        # reviendrait à ne rien livrer du tout.
        args.print_report = True
        print("")
        print("⚠️  Le seul dossier inscriptible est le dossier PRIVÉ de l'appli, invisible")
        print("    depuis le gestionnaire de fichiers Android. Le rapport sera donc AFFICHÉ")
        print("    ICI à la fin, prêt à copier.")
        print("    Pour l'avoir en fichier : Réglages Android → Applications → Pydroid 3 →")
        print("    Autorisations → Fichiers, puis relancer.")
        print("")

    chosen = list(SITES)
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        chosen = [s for s in chosen if s.id in wanted]
    if args.skip:
        unwanted = {s.strip() for s in args.skip.split(",") if s.strip()}
        chosen = [s for s in chosen if s.id not in unwanted]
    if not chosen:
        print("Aucun site sélectionné.")
        return 1

    md_path = os.path.join(args.out, "rapport-solveurs.md")
    json_path = os.path.join(args.out, "rapport-solveurs.json")
    started = time.time()

    # Reprise. Sur un téléphone qui s'endort au bout de dix minutes, refaire le
    # scan depuis le début à chaque fois ne converge jamais. Seuls les sites
    # menés à leur terme sont réutilisés, et seulement si le rapport vient de
    # cette version du script.
    previous = [] if args.fresh else load_previous(json_path)
    already = {r["id"]: r for r in previous if r.get("complete")}
    if already:
        print("Reprise : %s site(s) déjà sondés, ils ne seront pas refaits." % len(already))
        print("          (`--fresh`, ou supprime %s, pour tout reprendre.)"
              % os.path.basename(json_path))
    remaining = [s for s in chosen if s.id not in already]

    print("Sondage de %s site(s), %.1fs entre requêtes, abandon après %s essai(s) vide(s)."
          % (len(remaining), args.delay, args.give_up or "aucun"))
    print("Sortie : %s" % args.out)
    print("Le rapport est réécrit après chaque étape : une veille de l'écran ne perd rien.")

    def meta_now(partial: bool) -> dict:
        return {
            "when": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "requests": scanner.requests,
            "delay": args.delay,
            "give_up": args.give_up,
            "seconds": int(time.time() - started),
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "version": VERSION,
            "partial": partial,
            "expected": len(chosen),
        }

    def write(rows: list[dict]) -> None:
        """Réécrit les deux fichiers. Appelé à chaque étape, pas à la fin."""
        ordered = order_by(chosen, list(already.values()) + rows)
        partial = sum(1 for r in ordered if r.get("complete")) < len(chosen)
        meta = meta_now(partial)
        # Fichier temporaire puis renommage : une coupure au milieu de
        # l'écriture laisserait sinon un rapport tronqué à la place du bon.
        for path, payload in (
            (md_path, markdown(ordered, meta)),
            (json_path, json.dumps({"meta": meta, "sites": ordered},
                                   ensure_ascii=False, indent=2)),
        ):
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(tmp, path)

    scanner = Scanner(args, sink=write)
    interrupted = False
    for site in remaining:
        try:
            scanner.scan(site)
        except KeyboardInterrupt:
            print("\nInterrompu — le rapport porte sur ce qui a été sondé jusqu'ici.")
            interrupted = True
            break
        except Exception as exc:  # un site cassé ne doit pas emporter le scan
            print("  ⚠️ erreur inattendue sur %s : %s: %s" % (site.id, type(exc).__name__, exc))
            if scanner.current is None:
                scanner.current = {"id": site.id, "name": site.name, "url": site.home}
            scanner.current["error"] = "%s: %s" % (type(exc).__name__, exc)
            scanner.current["complete"] = True
        finally:
            scanner.commit()

    # Dernier passage par le scanner lui-même : lui appeler `write([])`
    # directement réécrirait le fichier avec zéro site, et effacerait le scan
    # entier au moment précis où il vient de se terminer.
    scanner.flush()
    reports = order_by(chosen, list(already.values()) + scanner.done)
    meta = meta_now(sum(1 for r in reports if r.get("complete")) < len(chosen))
    if interrupted or meta["partial"]:
        print("\n⚠️ Rapport partiel : %s site(s) sur %s menés à terme. Relance le script, "
              "il reprendra où il s'est arrêté."
              % (sum(1 for r in reports if r.get("complete")), len(chosen)))

    print("")
    print("=" * 68)
    print("  %s requêtes en %s s." % (scanner.requests, meta["seconds"]))
    print("  Rapport  : %s" % md_path)
    print("  Données  : %s" % json_path)
    if args.dump and os.path.isdir(scanner.dump_dir):
        print("  Pages    : %s" % scanner.dump_dir)
    print("=" * 68)
    print("")
    for report in reports:
        kind, why = classify(report)
        print("  %-28s %-18s %s" % (report.get("name", report.get("id")), BADGE.get(kind, kind), why))
    print("")
    if args.print_report:
        print("Copie tout ce qui suit, entre les deux repères.")
        print("")
        print("<<<<<<<<<< DÉBUT DU RAPPORT >>>>>>>>>>")
        print(markdown(reports, meta))
        print("<<<<<<<<<< FIN DU RAPPORT >>>>>>>>>>")
        print("")
    else:
        print("Envoie-moi rapport-solveurs.md (ou colle-le) et j'écris l'intégration.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
