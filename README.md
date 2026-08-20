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
- **Relecture en passes séparées** — la structure (type de chaque case, rognage des rangées
  parasites), puis les **textes**, puis les **flèches**, chaque élément affiché **à côté du
  crop de la case d'origine** : on corrige sans rouvrir le magazine. Les flèches ont leur
  propre file d'attente, signalée pour ses propres raisons (flèche déduite plutôt que lue,
  réponse qui ne mène nulle part) — mélangées aux textes, les flèches fausses se cachaient
  dans les définitions bien lues.
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

Un tour d'OCR complet prend quelques minutes, ce qui est trop lent pour itérer sur
la géométrie. Trois outils rendent la boucle courte — et surtout **visuelle**, car
la plupart des erreurs restantes se voient en une seconde sur une image et se
devinent mal dans des chiffres :

```bash
# score structurel sans OCR, en quelques secondes : accord de cadre, comptages
node --experimental-strip-types --import ./scripts/register-ts.mjs \
  scripts/dev-geom.mjs fixtures/*.jpg

# les cases détectées dessinées sur la photo redressée (+ quatre quartiers zoomés)
node --experimental-strip-types --import ./scripts/register-ts.mjs \
  scripts/dev-overlay.mjs fixtures/ma-photo.jpg

# les crops exacts envoyés à Tesseract, pour une case nommée
node --experimental-strip-types --import ./scripts/register-ts.mjs \
  scripts/dev-cell.mjs fixtures/ma-photo.jpg 0,0 4,8
```

`dev-geom.mjs` sert de garde-fou : une modification de géométrie qui améliore
l'alignement mais perd des cases-définitions n'est pas une amélioration.

### Vérifier qu'une mise à jour arrive vraiment

Une app à service worker peut servir le code d'hier indéfiniment, et la panne est
invisible : la page s'affiche, ce n'est simplement pas celle qui a été déployée.
Raisonner sur la configuration de workbox ne tranche pas — le comportement dépend
du moment où le navigateur va vérifier. Donc on mesure :

```bash
node scripts/dev-update.mjs
```

Il sert un build A, le charge comme le ferait un visiteur qui a déjà l'app,
remplace le dossier par un build B — un déploiement qui atterrit pendant que
l'app est ouverte — et compte les rechargements avant que le nouveau code tourne.
Il vérifie les **deux** chemins : recharger, et le chemin qu'une app installée
emprunte réellement, où l'on ne recharge jamais mais où l'on met en arrière-plan
et rouvre.

```bash
node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/dev-guard.mjs
```

Et celui-ci vérifie le garde-fou : une mise à jour ne doit pas recharger une
relecture dont les corrections ne sont pas encore enregistrées. Un garde-fou
seulement présent est pire que pas de garde-fou, puisqu'il se lit comme une
protection.

La version qui tourne est affichée dans **Réglages → À propos**, parce qu'une app
hors-ligne peut avoir une version de retard sans que ça se voie — et sans ça, un
rapport de bug et le code ne peuvent pas être mis en face l'un de l'autre.

### Vérifier que la grille se lit

```bash
npm run build && node scripts/dev-grid.mjs
```

Tout ce que la grille doit réussir — des définitions assez petites pour tenir et
assez grandes pour être lues, des flèches dans la case où la réponse commence,
deux définitions empilées dans une case, une flèche qui ne pointe nulle part —
est une question de pixels, et la seule façon honnête d'y répondre est de
regarder. Le script construit une grille contenant tous ces cas, l'importe par
le lecteur de paquets de l'app, et photographie l'écran de jeu à trois niveaux
de zoom dans `.debug/grid-*.png`.

Les définitions viennent d'une **transcription à la main** quand il y en a une
dans `fixtures/`, parce que leur longueur est toute la question.

Il chiffre ce qui se dégrade en silence :

- **combien de définitions sont affichées *entières***, et pas seulement
  affichées. Une case qui dit `ACCROIS…` n'est pas une définition, et la compter
  comme telle est la façon dont la grille a pu paraître lisible sans l'être ;
- **le zoom qu'une pression sur `+` atteint vraiment.** C'est le chiffre qui
  compte : un lecteur qui appuie une fois et voit encore des demi-définitions a
  compris que la commande ne marche pas ;
- **que le zoom survive au jeu.** Sélectionner un mot re-compose la barre de
  définition et redimensionne la grille de deux pixels ; si c'est pris pour « il
  faut réajuster », zoomer puis toucher une case vous rejette dehors ;
- **que les traits d'union cassent la ligne.** Les magazines coupent leurs
  définitions avec des tirets (ABAN-DONNÉE) et l'OCR les garde ; le corpus de
  test en contient donc, et une définition à tiret doit s'afficher entière ;
- **que les accents survivent.** `EMPLOYÉ` rendu `EMPLOYE` est un autre mot, et
  aucun comptage de texte ne le voit puisque le texte est juste : c'est la
  peinture qui est fausse. On mesure donc l'encre au-dessus de la ligne de base ;
- **les gestes, en vrai multi-touch** (pincements répétés, deux cases voisines
  touchées coup sur coup, deux fois la même case) — un pincement et un toucher
  sur une grille dense interfèrent d'une façon qu'une souris ne reproduit pas ;
- **où sont les flèches** : toutes dans des cases à remplir, sauf celles qui ne
  pointent vers aucune case, gardées dans la définition et signalées ;
- **la fluidité du zoom**, séparée en deux : les images *pendant* le geste, que
  la main sent, et la reprise une fois arrêté. Raccourcir une définition demande
  de mesurer du texte ; le faire à chaque image coûtait des images perdues.

## Partager une grille

Une grille scannée et corrigée se partage **par un simple lien**, sans aucun
serveur : le puzzle entier (structure, définitions, flèches, mot mystère,
difficulté) est compressé puis encodé dans le fragment `#g=…` de l'URL. Une
grille 13 × 17 fait environ 2 à 3 Ko de lien — ce que toutes les messageries
transmettent intact. Le fragment n'est jamais envoyé au serveur : GitHub Pages
sert la page comme d'habitude, et la grille voyage de téléphone à téléphone.

- **Envoyer** : bibliothèque → `⋯` sur la grille → *Partager le lien* (ou le
  menu `⋯` de l'écran de jeu). La feuille de partage du téléphone s'ouvre ;
  sans elle, le lien est copié.
- **Recevoir** : ouvrir le lien. L'app affiche la grille proposée — taille,
  nombre de définitions, difficulté — et demande avant d'ajouter. Une grille
  déjà présente est reconnue et jamais écrasée.

Ce qui **ne voyage pas** : la photo (volumineuse, et c'est une page de magazine
sous droits) et la progression de l'expéditeur — la grille arrive vierge. La
vignette est redessinée à partir de la forme de la grille.

La **difficulté** se saisit à la relecture (onglet Structure), telle qu'imprimée
sur la page du magazine ; elle s'affiche en badge dans la bibliothèque et dans
la proposition d'ajout, pour savoir dans quoi on se lance quand la grille vient
d'un ami.

Limite à connaître : sur iPhone, une app installée sur l'écran d'accueil a un
stockage séparé de Safari — un lien ouvert dans Safari ajoute la grille à la
bibliothèque de Safari, pas à celle de l'app installée. Sur Android, les deux
sont partagés et tout arrive au même endroit.

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

| | Au départ | Structure corrigée | **Géométrie corrigée** | Vérité |
| --- | --- | --- | --- | --- |
| Grille | 14 × 19 | 13 × 17 | **13 × 17** | 13 × 17 |
| Cases-définitions | 68 | 41 | **41** | 41 |
| Cases-lettres | 198 | 180 | **180** | 180 |
| Filets internes | — | 28 | **30** | 30 |
| Définitions produites | 116 | 69 | **71** | 71 |
| **Exactes** | 31 (43,7 %) | 55 (77,5 %) | **67 (94,4 %)** | |
| Presque (≤ 2 corrections) | 6 | 11 | **4** | |
| **Utilisables** | 37 (52,1 %) | 66 (93,0 %) | **71 (100 %)** | |
| **Manquantes** | 28 | 5 | **0** | |
| **Parasites** | 56 | 3 | **0** | |
| Cases orphelines | 7 | 2 | **0** | 0 |

La structure est **exacte** : colonnes, rangées, cases-définitions, cases-lettres
et filets internes correspondent tous au papier. Aucune définition n'est perdue,
aucune n'est inventée, et les quatre restantes se corrigent d'une ou deux touches.

Les frontières tombent sur les filets imprimés à **0,998** d'accord de cadre en
moyenne, contre 0,936 auparavant, et plus aucune case n'est sous 0,75. Sur la
seconde photo, plus difficile, le même chiffre passe de 0,829 à 0,991.

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

### Puis : le découpage était juste, il était mal placé

Une fois la structure exacte, les erreurs restantes ne venaient plus de l'OCR mais
de **quelques pixels de géométrie**. Trois corrections, dans l'ordre où elles ont
été trouvées :

4. **Le cadre de découpe se règle sur le texte, il ne se devine pas.** Rogner une
   fraction fixe de chaque bord doit couvrir le pire cas, donc coupe dans le cas
   courant : à 7 % d'une case, 29 des 41 cases avaient un glyphe tranché en deux.
   Le dégât est invisible dans le résultat mais fatal — un demi-U se lit L
   (`METS EN JEU` → `METS EN JEL`), un O privé de son arc gauche se lit D
   (`OBSCURITÉS` → `DBSCURITÉS`), et une première lettre assez rabotée disparaît
   (`DYNAMIQUES` → `YNAMIQUES`). Chaque bord part maintenant d'un retrait sûr et ne
   s'écarte que tant qu'il coupe encore de l'encre, jusqu'à la gouttière que la page
   imprime entre le texte et le filet. **55 → 61 exactes.**
5. **Une frontière perdue se retrouve grâce à ses voisines.** Chaque frontière est
   suivie séparément, ce qui ne lui laisse qu'un seul indice par bande — son propre
   filet ; là où il est pâle, le suivi s'accroche à une ligne de texte et la dérive
   propage l'erreur. Or une grille imprimée est régulière : dans une bande, ses
   filets décrivent un arc peu profond contre leur indice. Une frontière en
   désaccord avec un ajustement robuste de sa bande n'est pas en train de suivre la
   page, elle est perdue — et ses voisines disent où elle devrait être.
   L'ajustement doit être *courbe* : la page bombe, et l'arc à lui seul consomme
   une tolérance droite de 0,3 pas.
6. **Les filets se lisent en niveaux de gris, pas dans le binaire.** Le binaire est
   ce qui rend la grille trouvable sous le gradient d'ombre d'une photo à main
   levée, mais le seuillage épaissit et déplace un filet d'un pixel. La frontière
   haute de cette page s'était posée 22 px sous son filet — un cinquième de case —
   c'est-à-dire *à l'intérieur* de la première ligne de
   `ACCROIS-SEMENT DE LA VITESSE`, si bien que la découpe commençait à l'interligne
   en dessous. En gris, le filet ne trompe pas : il encre 90 pixels sur 90 de la
   bande, là où la ligne de capitales la plus sombre en encre 40. **61 → 67
   exactes, et plus aucune définition perdue.**

Une approche **essayée et écartée** : ajuster l'échelle entière par bande au lieu
de suivre chaque frontière. C'est séduisant — vingt indices par bande au lieu d'un
— mais les bandes extérieures sont surtout de la marge (la bande 0 finit à x=117,
la grille commence à x=85), et livrées à elles-mêmes elles se calent sur le bord de
page et la reliure. La seconde photo y perdait tout son accord de cadre (0,83 →
0,77) et trois cases-définitions.

## Limites connues

- **L'orientation ne se détecte de façon fiable que sur une page à plat.** Mesuré dans les
  deux sens sur deux photos : la page plane sépare nettement (+0,73 à l'endroit, −0,67
  couchée), la page bombée ne donne aucun signal (+0,06 et +0,23 — dans le mauvais ordre).
  L'app ne prévient donc que lorsqu'elle est sûre : le silence est la réponse honnête quand
  il n'y a pas de signal. Le contrôle de vraisemblance après l'OCR rattrape le cas d'une
  page mal orientée, demi-tour compris.
- **Le 100 % n'est vérifié que sur une page à plat**, celle qui est transcrite. Sur la
  seconde photo, bombée, seuls les indicateurs structurels sont mesurables : l'accord de
  cadre y passe de 0,829 à 0,991 et plus aucune case n'est mal cadrée, ce qui va dans le
  bon sens — mais sans transcription de cette page je ne peux pas en donner l'exactitude.
  Photographier la page **bien à plat change beaucoup** le résultat.
- Les rangées et colonnes hors grille (bord de page, en-tête, reliure) sont **pelées
  automatiquement** : une bordure qui n'est pas imprimée n'est pas de la grille, et l'écart
  est net — les bords fantômes s'accordent à 0,29, 0,02 et 0,01 avec des filets imprimés, là
  où la plus faible rangée réelle des deux grilles est à 0,78. La passe « Structure » de la
  relecture reste là pour rogner un cas limite.
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
