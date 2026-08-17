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
  components/           GridView (zoom/pan), Keyboard, CropStage, Sheet
  screens/              Library, Import, Review, Play, Settings
```

`image.ts`, `gridGeometry.ts`, `gridDetect.ts` et `ocr.ts` ne touchent ni au DOM ni au canvas :
c'est ce qui permet de les faire tourner sous Node dans les harnais de calibration.

## Ce que ça donne en vrai

Mesuré sur une photo de test réelle — un *Sport Cérébral* photographié à main levée, page
bombée, inclinée de quelques degrés, éclairage inégal, **sans recadrage manuel** :

| | Résultat |
| --- | --- |
| Grille détectée | 14 × 18 (la vraie grille + 1 bordure parasite) |
| Définitions trouvées | 63 cases, dont les cases à deux définitions découpées en deux |
| Définitions lues correctement | **~80 %** (60 sur 75 non vides) |
| Durée de l'import | ~30 s sur un mobile récent |

Le recentrage des crops sur l'encre avant reconnaissance est ce qui compte le plus : il fait
passer la lecture de ~24 % à ~80 %, parce qu'il rend l'OCR insensible à un cadrage de case
décalé de quelques pour cent.

## Limites connues

- **Une photo à l'envers n'est pas détectée automatiquement.** Le test d'orientation repère
  une photo couchée (le texte court de haut en bas) mais pas un demi-tour : dans les deux cas
  les lignes de texte sont horizontales. Un contrôle de vraisemblance après l'OCR rattrape le
  coup et propose le demi-tour, au lieu d'enregistrer du bruit en silence.
- La détection trouve souvent **une rangée ou une colonne en trop** (bord de page, en-tête).
  Un recadrage serré l'évite, et la passe « Structure » de la relecture permet de rogner.
- Les **flèches coudées** ne sont pas reconnues automatiquement : elles sont proposées comme
  variante et se choisissent dans la relecture.
- L'OCR d'un texte imprimé à 6 pt reste imparfait. La relecture n'est pas un rattrapage
  d'échec, c'est une étape assumée du flux.
- Le **mot mystère** (définition en marge + cases numérotées) n'est pas modélisé ; ces cases
  se remplissent comme les autres.

## Licence

Usage personnel. Les grilles numérisées restent la propriété de leurs éditeurs : cette app est
un carnet de remplissage pour des grilles que tu as achetées, pas un outil de redistribution.
