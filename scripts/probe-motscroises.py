#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sonde motscroises.fr — tout ce qu'il faut pour l'intégrer, et rien d'autre.

Phase 1 (faite, résultat au README) : le site est-il appelable depuis la PWA ?
Oui. `Access-Control-Allow-Origin` couvre l'origine GitHub Pages sur la page de
résultats elle-même, préflight OPTIONS compris. Aucun serveur nécessaire, et
`https://www.motscroises.fr/sujet/{definition-en-tirets}` est l'URL qui répond.

Phase 2 (ce script) : trois choses manquent pour écrire le lecteur de page.

  1. **La structure de la page de résultats.** On n'en a vu qu'un fragment —
     assez pour deviner, pas assez pour écrire. Un parseur écrit sur une
     supposition se casse sur la première vraie page ; il en faut le squelette.

  2. **Pourquoi « FLEUVE D'ÉGYPTE » n'a rien rendu.** Deux explications très
     différentes : soit l'apostrophe déforme l'URL, soit le site n'a pas cette
     définition. La première se corrige, la seconde se subit — et on ne saura
     laquelle qu'en essayant les variantes.

  3. **La recherche par motif.** La page contient un lien vers
     `/sujet/ASTRE-DU-JOUR/6/******`. Six étoiles pour six cases : le site sait
     filtrer sur les lettres déjà connues. Dans une grille, les cases déjà
     remplies contraignent le mot — pouvoir les passer ferait la différence
     entre « voici vingt candidats » et « voici la réponse ».

Usage : ouvrir dans Pydroid 3, appuyer sur ▶. Rien à taper. Le rapport
s'affiche à la fin, prêt à copier.
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
ROOT = "https://www.motscroises.fr"
TIMEOUT = 25
DELAY = 0.4


# --------------------------------------------------------------------------- #
# Outils
# --------------------------------------------------------------------------- #

def deaccent(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text)
                   if unicodedata.category(c) != "Mn")


class Resp:
    def __init__(self, url: str) -> None:
        self.url, self.status, self.error = url, 0, ""
        self.headers: dict[str, str] = {}
        self.text, self.body, self.ms = "", b"", 0

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
    return raw.decode("utf-8", "replace")


_last = [0.0]


def http(url: str, method: str = "GET") -> Resp:
    gap = time.time() - _last[0]
    if _last[0] and gap < DELAY:
        time.sleep(DELAY - gap)
    resp = Resp(url)
    headers = {"User-Agent": UA, "Accept-Encoding": "gzip, deflate",
               "Accept": "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9",
               "Origin": ORIGIN}
    request = urlrequest.Request(url, method=method, headers=headers)
    started = time.time()

    def attempt(context):
        with urlrequest.urlopen(request, timeout=TIMEOUT, context=context) as raw:
            resp.body = raw.read()
            resp.headers = {k.lower(): v for k, v in raw.headers.items()}
            resp.status, resp.text = raw.status, _decode(resp.body, dict(resp.headers))

    try:
        attempt(None)
    except urlerror.HTTPError as exc:
        resp.status, resp.error = exc.code, "HTTP %s" % exc.code
        try:
            resp.body = exc.read()
            resp.text = _decode(resp.body, {})
        except Exception:
            pass
    except ssl.SSLError:
        try:
            relaxed = ssl.create_default_context()
            relaxed.check_hostname = False
            relaxed.verify_mode = ssl.CERT_NONE
            attempt(relaxed)
        except Exception as exc:
            resp.error = "TLS: %s" % exc
    except Exception as exc:
        resp.error = "%s: %s" % (type(exc).__name__, exc)
    resp.ms = int((time.time() - started) * 1000)
    _last[0] = time.time()
    return resp


NOISE = re.compile(r"<(script|style|svg|noscript)\b.*?</\1>", re.I | re.S)

# Vue écrit ses marqueurs de portée **sans valeur** — `<div data-v-7f21ab90>` —
# aussi souvent qu'avec. Exiger un `=` en laissait passer la moitié. Le
# `(?=[\s>/])` évite d'amputer un attribut dont le nom commence pareil.
VUE_ATTR = re.compile(
    r"\s(?:data-v-[0-9a-f]+|style|aria-[\w-]+|role|target|rel)"
    r"(?:=(?:\"[^\"]*\"|'[^']*'|[^\s>]+))?(?=[\s>/])",
    re.I,
)


def skeleton(markup: str) -> str:
    """
    La page débarrassée de ce qui n'apprend rien.

    Scripts, styles, et les attributs que Vue sème partout : ils triplent le
    volume sans rien dire de la structure, et c'est la structure qu'il faut
    transmettre — un rapport trop gros ne se colle pas.
    """
    text = NOISE.sub(" ", markup)
    text = VUE_ATTR.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def window(text: str, needle: str, before: int, after: int) -> str:
    at = text.find(needle)
    if at < 0:
        return ""
    return text[max(0, at - before): at + after]


def has_answer(resp: Resp, answer: str) -> bool:
    plain = deaccent(re.sub(r"<[^>]+>", " ", resp.text)).upper()
    return bool(re.search(r"\b%s\b" % re.escape(answer), plain))


def hyphenate(clue: str, upper: bool, apostrophe: str) -> str:
    """
    Une définition en segment d'URL.

    `apostrophe` vaut `hyphen`, `drop` ou `keep`, et les trois donnent trois URL
    différentes — `fleuve-d-egypte`, `fleuve-degypte`, `fleuve-d'egypte`. C'est
    tout l'objet du test : savoir laquelle le site attend. Les confondre ferait
    essayer trois fois la même et conclure à tort.
    """
    text = deaccent(clue)
    text = text.upper() if upper else text.lower()
    if apostrophe == "drop":
        text = text.replace("'", "")
    elif apostrophe == "hyphen":
        text = text.replace("'", "-")
    keep = "'" if apostrophe == "keep" else ""
    return re.sub(r"[^A-Za-z0-9%s]+" % keep, "-", text).strip("-")


# --------------------------------------------------------------------------- #
# Les trois questions
# --------------------------------------------------------------------------- #

def structure(out: list[str]) -> None:
    say = out.append
    print("\n=== 1. Structure de la page de résultats ===", flush=True)
    url = "%s/sujet/astre-du-jour" % ROOT
    resp = http(url)
    say("## 1. Structure d'une page de résultats")
    say("")
    say("`%s` → %s en %s ms, %s Ko bruts" % (url, resp.status, resp.ms, len(resp.body) // 1024))
    if not resp.ok:
        say("Échec : %s" % (resp.error or resp.status))
        print("  échec", flush=True)
        return

    clean = skeleton(resp.text)
    say("Squelette (scripts, styles et attributs Vue ôtés) : %s Ko" % (len(clean) // 1024))
    say("")

    # Le tableau complet des solutions : c'est lui qu'il faut lire, pas le
    # résumé du haut de page qui n'en montre qu'une poignée.
    for label, needle, before, after in (
        ("Résumé en tête de page", "top-results-group", 700, 1400),
        ("Tableau complet des solutions", "result-table", 200, 3200),
    ):
        chunk = window(clean, needle, before, after)
        print("  %s : %s" % (label, "trouvé" if chunk else "ABSENT"), flush=True)
        say("### %s (`%s`)" % (label, needle))
        say("")
        if chunk:
            say("```html")
            say(chunk)
            say("```")
        else:
            say("Repère absent de la page.")
        say("")

    # Combien de solutions la page annonce-t-elle ? Un parseur qui en rend un
    # autre nombre se trompe, et c'est le seul contrôle disponible d'avance.
    # Cherché dans le HTML brut : le compte est dans le JSON-LD, que le
    # squelette vient justement d'ôter.
    announced = re.search(r"il y a .{0,40}?(\d+) solutions?", resp.text, re.I)
    lengths = sorted(set(re.findall(r"(\d{1,2})\s*Lettres?\s*:", clean, re.I)), key=int)
    say("- Solutions annoncées par la page : %s" % (announced.group(1) if announced else "?"))
    say("- Longueurs proposées : %s" % (", ".join(lengths) or "aucune"))
    say("")


def apostrophe(out: list[str]) -> None:
    say = out.append
    print("\n=== 2. Définition à apostrophe ===", flush=True)
    say("## 2. « FLEUVE D'ÉGYPTE » — apostrophe, ou trou de couverture ?")
    say("")
    clue = "FLEUVE D'ÉGYPTE"
    variants = [
        ("minuscules, apostrophe → tiret", hyphenate(clue, False, "hyphen")),
        ("MAJUSCULES, apostrophe → tiret", hyphenate(clue, True, "hyphen")),
        ("minuscules, apostrophe supprimée", hyphenate(clue, False, "drop")),
        ("MAJUSCULES, apostrophe supprimée", hyphenate(clue, True, "drop")),
        ("minuscules, apostrophe gardée", hyphenate(clue, False, "keep")),
        ("accent conservé", urlparse.quote("fleuve-d-égypte", safe="-")),
    ]
    found = False
    for label, slug in variants:
        resp = http("%s/sujet/%s" % (ROOT, slug))
        hit = resp.ok and has_answer(resp, "NIL")
        found = found or hit
        print("  %s %s" % ("✓" if hit else ("·" if resp.ok else "⨯"), slug), flush=True)
        say("- %s `%s` → %s%s" % ("✓" if hit else ("·" if resp.ok else "⨯"), slug,
                                  resp.status if not resp.error else resp.error,
                                  ", NIL trouvé" if hit else ""))

    # Un témoin sans apostrophe, pour savoir si c'est la ponctuation ou le fond.
    control = http("%s/sujet/%s" % (ROOT, hyphenate("OISEAU DE MALHEUR", False, False)))
    control_hit = control.ok and has_answer(control, "CORBEAU")
    say("- témoin sans apostrophe `oiseau-de-malheur` → %s%s"
        % (control.status, ", CORBEAU trouvé" if control_hit else ", rien"))
    say("")
    say("**Lecture** : une variante qui répond ⇒ c'était l'URL. Aucune, mais le témoin "
        "répond ⇒ le site n'a tout simplement pas cette définition, et il faudra une "
        "seconde source pour les trous.")
    say("")


def pattern(out: list[str]) -> None:
    say = out.append
    print("\n=== 3. Recherche par motif ===", flush=True)
    say("## 3. Recherche par motif — passer les lettres déjà croisées")
    say("")
    say("Dans une grille, les cases déjà remplies contraignent le mot. Si le site accepte "
        "un motif, un indice peut être exact au lieu d'être un pari.")
    say("")
    trials = (
        ("toutes cases libres", "ASTRE-DU-JOUR/6/******"),
        ("motif partiel", "ASTRE-DU-JOUR/6/S*L**L"),
        ("motif qui exclut la réponse", "ASTRE-DU-JOUR/6/Z*****"),
        ("minuscules", "astre-du-jour/6/******"),
        ("longueur seule", "ASTRE-DU-JOUR/6"),
        ("longueur qui ne correspond à rien", "ASTRE-DU-JOUR/9/*********"),
    )
    for label, tail in trials:
        url = "%s/sujet/%s" % (ROOT, tail)
        resp = http(url)
        hit = resp.ok and has_answer(resp, "SOLEIL")
        print("  %s %s" % ("✓" if hit else ("·" if resp.ok else "⨯"), tail), flush=True)
        say("- %s %s — `/sujet/%s` → %s, SOLEIL %s, %s Ko"
            % ("✓" if hit else ("·" if resp.ok else "⨯"), label, tail,
               resp.status if not resp.error else resp.error,
               "présent" if hit else "absent", len(resp.body) // 1024))
    say("")
    say("**Lecture** : si « motif partiel » répond et que « motif qui exclut la réponse » "
        "ne répond pas, le filtre est réel et l'app peut s'en servir.")
    say("")


def main() -> int:
    print("Sonde motscroises.fr — structure, apostrophe, motif")
    print("Le rapport s'affiche à la fin, prêt à copier.")
    started = time.time()

    out: list[str] = ["# motscroises.fr — ce qu'il reste à savoir", ""]
    structure(out)
    apostrophe(out)
    pattern(out)
    out.append("_%s s._" % int(time.time() - started))
    report = "\n".join(out)

    for base in ("/storage/emulated/0/Download", "/sdcard/Download", os.getcwd()):
        try:
            if not os.path.isdir(base):
                continue
            path = os.path.join(base, "rapport-motscroises.md")
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
