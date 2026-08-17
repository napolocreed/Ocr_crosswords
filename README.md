# Grilles — mots fléchés

PWA pour numériser les mots fléchés de magazine et les remplir partout, hors-ligne.

Photographie une grille, l'app détecte sa structure et lit les définitions par OCR, tu corriges
ce qui a été mal lu tant que le magazine est encore sous la main, et tu emportes ta bibliothèque
de grilles dans ta poche.

**100 % frontend, 100 % local.** Aucun serveur, aucun compte : les photos, la reconnaissance et
les grilles ne quittent jamais l'appareil. Déployable sur GitHub Pages.

## Ce que ça fait

- **Import par photo** — recadrage à 4 coins + rotation, détection de la grille, OCR français
  embarqué (Tesseract WASM).
- **Relecture en deux passes** — d'abord la structure (type de chaque case, rognage des rangées
  parasites), puis les définitions, chacune affichée **à côté du crop de la case d'origine** :
  on corrige sans rouvrir le magazine.
- **Remplissage lettre par lettre** — clavier AZERTY intégré, grille zoomable, définition
  active rappelée en taille lisible.
- **Mode brouillon** — jusqu'à 4 lettres candidates par case, affichées en petit et en gris
  quand on hésite.
- **Mot mystère** — la définition en marge et les cases numérotées qui l'alimentent. La réponse
  s'assemble toute seule à mesure que la grille se remplit, dans une barre sous la grille.
- **Bibliothèque hors-ligne** — sauvegarde automatique, export/import de « packs » de grilles
  en un fichier JSON pour en emporter plusieurs d'un coup ou les passer sur un autre téléphone.

## Démarrer

```bash
npm install
npm run dev      # télécharge les assets OCR au premier lancement, puis sert l'app
```

Scripts utiles :

| Commande | Rôle |
| --- | --- |
| `npm run build` | typecheck + build de production dans `dist/` |
| `npm run typecheck` | TypeScript seul |
| `npm run prepare:ocr` | (re)vendorise le moteur OCR dans `public/tesseract/` |
| `npm run icons` | régénère les icônes PWA |

## Déploiement sur GitHub Pages

Le workflow `.github/workflows/deploy.yml` construit et publie à chaque push sur `main`.
Une seule chose à faire côté GitHub : **Settings → Pages → Source : GitHub Actions**.

Le chemin de base est déduit du nom du dépôt. Pour un domaine personnalisé ou une autre
racine, surcharge `VITE_BASE` (par exemple `VITE_BASE=/ npm run build`).

## Comment marchent les flèches

C'est le seul endroit où la géométrie ne suffit pas : une flèche droite `↓` et une flèche
coudée `└→` partent toutes deux de la case sous la définition, donc rien dans la structure ne
les distingue. Il faut lire le glyphe imprimé.

Ce qui rend la chose abordable : **les cases à remplir sont vides**. Tout composant connexe
qu'on y trouve est donc soit un glyphe de flèche, soit un indice de mot mystère — et les deux
se séparent facilement, une flèche partant toujours d'un bord alors qu'un indice flotte au
milieu.

Le classement repose ensuite sur deux faits mesurés sur de vraies photos :

1. **L'axe long du glyphe donne le sens de lecture de la réponse.** Les deux bras d'un coude
   sont inégaux et celui qui porte la pointe est toujours le plus long.
2. **Le bord d'entrée désigne la case-définition propriétaire.** En général une seule des
   deux cases voisines *est* une définition, ce qui tranche sans rien deviner : un glyphe
   vertical dans une case dont la seule définition est à gauche *est* forcément un coude.

Quand les deux voisines sont des définitions, on retombe sur la forme du coude — un `L`
laisse un coin de sa boîte vide, une ligne droite la remplit (mesuré : 0,34–0,42 de
remplissage pour les coudes contre 0,47–1,00 pour les droites).

Une première version classait par le bord touché : elle échouait silencieusement, parce qu'un
coude blotti dans un angle touche *les deux* bords et que tout arbitrage entre eux est un
tirage au sort — la moitié des coudes étaient rapportés comme des flèches droites.

**Contrôle objectif** : avec des flèches correctes, toute case à remplir doit être atteignable
depuis une définition. Les cases orphelines sont passées de 36 à **3 sur 183**.

## Comment marche la détection

C'est la partie délicate : une photo à main levée d'un magazine broché n'est ni plane ni
d'aplomb. Trois problèmes se cumulent, et chacun casse l'approche naïve.

1. **L'inclinaison.** Une règle imprimée inclinée de 3° ne reste dans une même rangée de pixels
   que sur ~15 px. Toute détection fondée sur des sommes par rangée ou des « longs traits
   horizontaux » la manque complètement. L'encre est donc accumulée le long de **familles de
   droites obliques**, et l'angle retenu est celui qui concentre le plus l'encre
   (`src/lib/gridGeometry.ts`).
2. **Le bombé de la page.** Les règles ne sont même pas parallèles entre elles. Plutôt que de
   les redresser de force, chaque règle est trouvée dans une **bande centrale** — là où le
   bombé est négligeable — puis **suivie de bande en bande** vers les bords. Les frontières
   renvoyées sont donc des courbes qui épousent la page, ce qui garde les crops alignés sur
   l'impression.
3. **Tout ce qui n'est pas la grille.** En-tête, logo du magazine, bande du mot mystère, bord
   sombre de la page. La grille est la famille de lignes **la plus régulièrement espacée** de
   l'image : sélectionner la meilleure progression arithmétique parmi les candidates élimine
   les intrus sans réglage. Le pas est réestimé au fil du parcours, sinon une erreur initiale
   de quelques pour cent s'accumule et tronque la grille avant la fin.

Le classement des cases se fait ensuite au taux d'encre (vide / définition / case noire), et
les cases à **deux définitions** sont repérées par leur filet horizontal interne, puis lues en
deux morceaux séparés.

Les flèches restent le point faible : imprimées très fines et à cheval sur une bordure, elles
se détectent mal. La géométrie fait donc l'essentiel du travail — une flèche ne peut viser
qu'une case à remplir, donc une case de définition n'ayant qu'un seul voisin libre n'est pas
ambiguë — l'image ne servant qu'à trancher les cas douteux. Le reste se corrige d'un tap dans
la relecture.

### Calibrer sur ses propres photos

Les photos de test ne sont pas versionnées (`fixtures/` est ignoré) : les pages de magazine
sont sous droits. Dépose les tiennes dans `fixtures/`, puis mesure sans navigateur ni
téléphone :

```bash
# structure : carte de la grille, alignement des frontières, images de debug
node --experimental-strip-types --import ./scripts/register-ts.mjs \
  scripts/dev-detect.mjs fixtures/ma-photo.jpg --rotate 1 --zoom 60,60,340,300

# OCR réel case par case, avec les crops envoyés à Tesseract
node --experimental-strip-types --import ./scripts/register-ts.mjs \
  scripts/dev-ocr.mjs fixtures/ma-photo.jpg --rotate 1 --limit 20
```

Les sorties vont dans `.debug/`. La métrique à surveiller est l'**alignement** : la fraction de
chaque frontière détectée qui tombe effectivement sur une règle imprimée.

Et le test de bout en bout, dans un vrai Chromium, du choix de la photo jusqu'à la sauvegarde :

```bash
npm run build && node scripts/smoke.mjs   # attend une photo dans fixtures/
```

Et la mesure d'exactitude, contre une page transcrite à la main
(`fixtures/<photo>.truth.json` à côté de la photo) :

```bash
node --experimental-strip-types --import ./scripts/register-ts.mjs \
  scripts/score.mjs fixtures/ma-photo.jpg --detail
```

## Architecture

```
src/
  types.ts              modèle de données (4 types de flèches, dont les coudées)
  lib/
    image.ts            primitives pixel pures (gris, seuillage adaptatif, homographie)
    gridGeometry.ts     détection des règles : projections obliques + suivi par bandes
    gridDetect.ts       classement des cases, filets internes, indices de flèche
    ocr.ts              Tesseract + nettoyage du texte français en capitales
    importPipeline.ts   orchestration photo → grille
    puzzle.ts           dérivation des mots depuis les flèches
    db.ts               IndexedDB (grilles légères / assets lourds séparés)
    exchange.ts         packs d'export / import
  components/           GridView (zoom/pan), Keyboard, MysteryBar, CropStage, Sheet
  screens/              Library, Import, Review (structure / définitions / mystère), Play, Settings
```

`image.ts`, `gridGeometry.ts`, `gridDetect.ts` et `ocr.ts` ne touchent ni au DOM ni au canvas :
c'est ce qui permet de les faire tourner sous Node dans les harnais de calibration.

## Ce que ça donne en vrai

Mesuré par `scripts/score.mjs` contre une page **transcrite à la main**, ce qui est la
seule métrique qui compte : combien de définitions sont lues au caractère près.

Sur une page à plat, bien éclairée, sans recadrage manuel :

| | Avant | **Après** | Vérité |
| --- | --- | --- | --- |
| Grille | 14 × 19 | **13 × 17** | 13 × 17 |
| Cases-définitions | 68 | **41** | 41 |
| Cases-lettres | 198 | **180** | 180 |
| Définitions produites | 116 | **69** | 71 |
| **Exactes** | 31 (43,7 %) | **55 (77,5 %)** | |
| Presque (≤ 2 corrections) | 6 | **11** | |
| **Utilisables** | 37 (52,1 %) | **66 (93,0 %)** | |
| **Parasites** | **56** | **3** | |
| Cases orphelines | 7 | **2** | 0 |

La structure est désormais **exacte** : le nombre de colonnes, de rangées, de
cases-définitions et de cases-lettres correspond au papier.

### Attention aux métriques indirectes

Les chiffres publiés avant l'existence de `score.mjs` étaient faux — pas les
nombres, la question posée. Ils comptaient les chaînes qui *ressemblent* à des
mots (majuscules, une voyelle, 4 caractères), or `"LEUVT EEE ÇA REMPL LE VERRI"`
satisfait ce test. Le proxy annonçait ~80 % là où la réalité était ~44 %.

C'est la leçon la plus utile de ce projet : **une métrique indirecte peut faire
croire à un succès pendant des heures.**

### Les trois corrections qui ont produit ce gain

1. **Une case-définition doit d'abord être une case de la grille imprimée.** Le
   parcours des frontières prolonge la grille d'une ou deux rangées au-delà du
   papier — sur l'en-tête, la marge, l'ombre de reliure — et ces bandes sont assez
   sombres pour passer n'importe quel test de noirceur. 26 des 68 « définitions »
   étaient de tels fantômes. Seule l'impression encadre une case.
2. **Un filet interne se reconnaît à son segment continu, pas à sa noirceur.** À
   la résolution d'une photo, une ligne de capitales est en moyenne plus sombre
   qu'un filet d'un pixel ; l'ancien test trouvait donc la ligne de texte au moins
   aussi souvent que le filet, inventant des scissions et coupant des mots en deux.
   Un filet est continu, du texte est haché — et les deux moitiés d'une vraie case
   scindée portent toutes deux du texte.
3. **Les bords fantômes sont pelés.** Une rangée de bordure appartient à la grille
   si elle porte une définition ou une case qu'une flèche atteint. Sinon c'est de
   la marge. C'est ce qui fait tomber les orphelines de 47 à 2.

Et une hypothèse **réfutée** par la mesure : j'attribuais les fausses cases au
texte du verso traversant le papier. C'était faux. Un critère de noirceur absolue
référencé à un percentile global s'est révélé *pire* que le seuillage local qu'il
remplaçait. La vraie cause était géométrique.

## Limites connues

- **L'orientation ne se détecte de façon fiable que sur une page à plat.** Mesuré dans les
  deux sens sur deux photos : la page plane sépare nettement (+0,73 à l'endroit, −0,67
  couchée), la page bombée ne donne aucun signal (+0,06 et +0,23 — dans le mauvais ordre).
  L'app ne prévient donc que lorsqu'elle est sûre : le silence est la réponse honnête quand
  il n'y a pas de signal. Le contrôle de vraisemblance après l'OCR rattrape le cas d'une
  page mal orientée, demi-tour compris.
- **Le gain n'est vérifié que sur une page à plat.** Sur la photo bombée, les définitions
  produites passent de 97 à 65 — 97 était manifestement trop, 65 est plausible, mais faute de
  transcription de cette page je ne peux pas l'affirmer. Photographier la page **bien à plat
  change beaucoup** le résultat.
- La détection trouve souvent **une rangée ou une colonne en trop** (bord de page, en-tête).
  Un recadrage serré l'évite, et la passe « Structure » de la relecture permet de rogner.
- Les **flèches coudées** ne sont pas reconnues automatiquement : elles sont proposées comme
  variante et se choisissent dans la relecture.
- L'OCR d'un texte imprimé à 6 pt reste imparfait. La relecture n'est pas un rattrapage
  d'échec, c'est une étape assumée du flux.
- Les **cases numérotées du mot mystère se désignent à la main** (passe 3 de la relecture :
  on tape les cases dans l'ordre). J'ai tenté de lire les petits chiffres automatiquement —
  par composantes connexes, pour séparer un chiffre d'une pointe de flèche — et à cette
  résolution le détecteur trouvait 11 pointes de flèches et zéro chiffre. Livrer une aide qui
  désigne les mauvaises cases est pire que pas d'aide : elle a été retirée. Numéroter 10 cases
  prend une quinzaine de secondes et le résultat est juste à coup sûr.

## Licence

Usage personnel. Les grilles numérisées restent la propriété de leurs éditeurs : cette app est
un carnet de remplissage pour des grilles que tu as achetées, pas un outil de redistribution.
