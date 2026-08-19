# PrintOasis Phase B Image Production Specification

This document is the production brief for the first premium product-image release. It does not add, download, generate, or move image files. It complements [IMAGE_LIBRARY.md](IMAGE_LIBRARY.md) and [IMAGE_ASSET_MANIFEST.md](IMAGE_ASSET_MANIFEST.md), which remain the implementation contract for image paths and renderer behaviour.

## Scope

Phase B is limited to these existing catalog categories:

- Business Cards
- Marketing Materials
- Corporate Gifting
- Expo Materials
- Custom Apparel
- Personalised Gifts

The catalog, routes, image infrastructure, and product IDs are fixed. Each entry below uses the exact product folder at `public/assets/images/products/<category>/<product-id>/`.

## Global Art Direction

- Create authentic commercial product photography, not generic lifestyle stock imagery.
- Use a consistent neutral-white or warm-charcoal studio base, soft directional lighting, natural shadows, and colour-accurate materials.
- Keep primary and hover images uncluttered with one clearly readable product. Reserve lifestyle scenes for the gallery.
- Products may carry the PrintOasis mark only when it can be applied accurately in post-production from approved brand artwork. Do not rely on generative text rendering for logos, names, offers, or product specifications.
- Use plausible, unbranded example artwork where a printed design must be visible. Never use a competitor logo or copied campaign artwork.
- Export only WebP, with sRGB colour, no baked-in UI, badges, prices, or CTA text.
- Each physical photo should be saved once in its product folder and then referenced by existing placements. Do not create homepage-only duplicates.

## Deliverable Standard

| Asset role | Target crop | Minimum export | Primary use |
| --- | --- | --- | --- |
| `primary.webp` | 4:3 | 2000 x 1500 | Product cards, listing, search, cart fallback |
| `hover.webp` | 4:3 | 2000 x 1500 | Card hover and keyboard focus |
| `featured.webp` | 4:3 | 2000 x 1500 | Featured / Most Loved Prints cards where specified |
| `hero.webp` | 16:9 | 2560 x 1440 | Product-led editorial or collection feature |
| Gallery view | 4:3 or 3:2 | 2000 px on longest edge | Product page gallery |
| `categories/<category>/hero.webp` | 16:9 | 2560 x 1440 | Existing category header |
| `categories/<category>/cover.webp` | 4:3 | 2000 x 1500 | Category cards and future collection treatments |

The existing renderer resolves `primary`, `hover`, gallery images, and context-specific `featured`, `trending`, and `recommendation` assets. Do not make derivative crops when the same photographed composition can be framed safely by the existing responsive layout.

## Variant Contract

For colour-capable products, each colour is a complete, independently photographed gallery. Use the exact folder pattern below. `primary.webp` and `hover.webp` in the product root identify the launch-default colour. A colour-selection implementation can later bind directly to each subfolder without replacing any image-system code.

```text
products/apparel/premium-cotton-hoodies/
  primary.webp                 # launch default: black front
  hover.webp                   # launch default: black back or angle
  black/front.webp
  black/back.webp
  black/folded.webp
  black/lifestyle.webp
  black/detail.webp
  white/front.webp
  ...
```

Every variant set uses `front.webp`, `back.webp` where relevant, `folded.webp`, `lifestyle.webp`, and `detail.webp`. It must not be a CSS tint of another colour. Maintain matching lighting, camera distance, logo scale, and garment styling between colours.

## Category Hero Briefs

| Category | Path | Required composition |
| --- | --- | --- |
| Business Cards | `categories/business-cards/hero.webp` | Deep charcoal desk, two premium cards, subtle paper texture and soft gold accent; ample negative space for existing SSR title. |
| Marketing Materials | `categories/marketing/hero.webp` | Coordinated flyer, brochure, folder and poster flat lay in a polished studio; campaign-ready, not crowded. |
| Corporate Gifting | `categories/corporate-gifting/hero.webp` | Open premium welcome box with diary, bottle, pen and apparel; restrained blue-and-ink PrintOasis palette. |
| Expo Materials | `categories/expo-materials/hero.webp` | Expo Welcome Kit at a finished stand with a softly defocused exhibition hall behind it. The kit is visually dominant. |
| Custom Apparel | `categories/apparel/hero.webp` | Navy corporate polo, folded hoodie and cap arranged in a studio with realistic fabric texture and clean side space. |
| Personalised Gifts | `categories/gifts/hero.webp` | Warm contemporary home desk with a photo mug, frame and album; polished but personal. |

Also produce `cover.webp` for each category from a distinct crop of the same photo session, not a copied file.

## Business Cards

**Photography direction:** premium desk scenes, controlled highlights, visible stock thickness, clean corners, and believable print finishes. Avoid invented readable contact text.

| Product ID | Primary and hover direction | Required gallery / detail views |
| --- | --- | --- |
| `standard-business-cards` | Clean front card on warm-white studio surface; hover is a modest 45-degree stack. | `hero`, `front`, `back`, `angle-01`, `stack-01`, `lifestyle-01`, `paper-edge-detail`. |
| `premium-business-cards` | Black or deep-navy premium card with an elegant desk prop; hover shows thickness. | `hero`, `front`, `back`, `angle-01`, `stack-01`, `edge-detail`, `lifestyle-01`, `featured`. |
| `matte-business-cards` | Soft, non-reflective card on charcoal paper; hover is a close 45-degree stack. | `hero`, `front`, `back`, `matte-detail`, `stack-01`, `lifestyle-01`. |
| `gloss-business-cards` | Crisp card with believable controlled reflections; hover changes the reflection angle. | `hero`, `front`, `back`, `gloss-detail`, `stack-01`, `lifestyle-01`. |
| `spot-uv-business-cards` | Dark matte front with a clear Spot UV catchlight; hover isolates the raised gloss. | `hero`, `front`, `back`, `angle-01`, `spot-uv-detail`, `stack-01`, `lifestyle-01`. |
| `premium-foil-cards` | Luxury card with post-produced gold or silver foil; hover shows the foil at an angle. | `hero`, `front`, `back`, `foil-detail`, `texture-01`, `stack-01`, `lifestyle-01`. |
| `textured-business-cards` | Tactile uncoated or linen card under raking light; hover is macro texture. | `hero`, `front`, `back`, `texture-01`, `texture-02`, `stack-01`, `lifestyle-01`. |
| `transparent-business-cards` | Clear or frosted PVC card against a restrained office scene; hover shows the edge and transparency. | `hero`, `front`, `back`, `angle-01`, `transparent-detail`, `stack-01`, `lifestyle-01`. |
| `eco-friendly-business-cards` | Recycled kraft or white recycled card with natural fibre texture; no rustic cliches. | `hero`, `front`, `back`, `kraft-texture`, `stack-01`, `lifestyle-01`. |
| `classic-business-cards` | Square-format card, direct overhead composition; hover provides scale with a hand or card stack. | `hero`, `front`, `back`, `angle-01`, `stack-01`, `detail-01`, `lifestyle-01`. |

## Marketing Materials

**Photography direction:** real working contexts such as reception desks, cafes, retail counters, sales meetings, and restaurant tables. Maintain accurate folds, page counts, and paper behaviour.

| Product ID | Primary and hover direction | Required gallery / detail views |
| --- | --- | --- |
| `professional-flyers` | Single flyer front on a clean surface; hover is a neat campaign stack. | `hero`, `front`, `back`, `stack-01`, `closeup-01`, `lifestyle-01`, `featured`. |
| `folded-brochures` | Standing tri-fold with one open spread; hover reveals the fold. | `hero`, `front`, `open-spread`, `folded`, `detail-01`, `lifestyle-01`. |
| `marketing-booklets` | Closed booklet cover with a gentle angle; hover is an open spread. | `hero`, `cover`, `open-spread`, `spine-detail`, `stack-01`, `lifestyle-01`. |
| `event-posters` | Presentation folder front, not a poster, on a meeting table; hover shows the card-slot interior. | `hero`, `front`, `open`, `inside-pocket`, `stack-01`, `meeting-scene`. |
| `product-catalogues` | Premium catalogue cover on a sales desk; hover opens to a designed spread. | `hero`, `cover`, `open-spread`, `spine-detail`, `stack-01`, `lifestyle-01`. |
| `promotional-postcards` | Card front with clean direct light; hover is a fanned stack with reverse side visible. | `hero`, `front`, `back`, `stack-01`, `detail-01`, `lifestyle-01`. |
| `printed-door-hangers` | Door hanger hanging naturally on a boutique or hotel handle; hover isolates the die-cut. | `hero`, `front`, `back`, `die-cut-detail`, `lifestyle-01`. |
| `restaurant-menus` | Menu closed on a contemporary restaurant table; hover is an open table setting. | `hero`, `cover`, `open-spread`, `lamination-detail`, `table-scene`. |
| `promotional-leaflets` | Single leaflet front against warm white; hover presents a compact handout stack. | `hero`, `front`, `back`, `stack-01`, `detail-01`, `lifestyle-01`. |
| `table-tent-cards` | Assembled tent card on a counter or table; hover is close fold detail. | `hero`, `front`, `back`, `fold-detail`, `table-scene`. |

## Corporate Gifting

**Photography direction:** refined corporate presentation, modern workspaces, soft blue, navy, charcoal, natural paper, and premium gift packaging. Use a coherent fictitious brand system, not text rendered by a generator.

| Product ID | Primary and hover direction | Required gallery / detail views |
| --- | --- | --- |
| `employee-welcome-kits` | Open, complete kit flat lay on a studio surface; hover shows the box open at 45 degrees. | `hero`, `flatlay`, `open-box`, `contents`, `packaging-detail`, `lifestyle-01`, `featured`. |
| `corporate-gift-hampers` | Ribbon-tied premium hamper; hover reveals a curated open box. | `hero`, `closed`, `open`, `contents`, `ribbon-detail`, `lifestyle-01`. |
| `corporate-polo-tshirts` | Navy polo front as default; hover is navy back/angle. | Root `primary`, `hover`, plus `navy`, `white`, `black`, and `grey` variant galleries: `front`, `back`, `folded`, `lifestyle`, `detail` in each. |
| `corporate-round-neck-tshirts` | White round-neck front as default; hover is a black or navy 45-degree view. | Root `primary`, `hover`, plus `white`, `black`, `navy`, and `grey` variant galleries: `front`, `back`, `folded`, `lifestyle`, `detail` in each. |
| `corporate-hoodies` | Black hoodie front as default; hover is black back or angled detail. | Root `primary`, `hover`, plus `black`, `grey`, and `navy` variant galleries: `front`, `back`, `folded`, `lifestyle`, `detail` in each. |
| `executive-diaries` | Closed debossed diary with pen on a calm executive desk; hover is an open spread. | `hero`, `cover`, `open-spread`, `cover-detail`, `desk-scene`, `gift-box`. |
| `premium-executive-pens` | Pen and gift case on charcoal studio base; hover is macro engraving. | `hero`, `front`, `engraving-detail`, `gift-box`, `desk-scene`. |
| `stainless-steel-water-bottles` | Silver bottle front as default; hover is black bottle side. | Root `primary`, `hover`, plus `silver`, `black`, `white`, and `blue` variant galleries: `front`, `side`, `lifestyle`, `detail` in each. |
| `branded-laptop-sleeves` | Sleeve front with a laptop partly inserted; hover reveals the open zip. | `hero`, `front`, `open`, `zipper-detail`, `laptop-inserted`, `lifestyle-01`. |
| `corporate-tote-bags` | Natural cotton tote front as default; hover is black tote at 45 degrees. | Root `primary`, `hover`, plus `natural`, `black`, and `navy` variant galleries: `front`, `back`, `folded`, `lifestyle`, `detail` in each. |

## Expo Materials

**Photography direction:** credible trade-show spaces, clean professional booth lighting, believable scale, no busy crowd faces. The Expo Welcome Kit is the flagship and receives the most editorial attention.

| Product ID | Primary and hover direction | Required gallery / detail views |
| --- | --- | --- |
| `expo-welcome-kits` | Hero kit on an exhibition counter as default; hover is a clean contents flat lay. | `hero`, `primary`, `hover`, `flatlay`, `open-box`, `contents`, `booth-scene`, `packaging-detail`, `featured`, `recommendation`. |
| `expo-roll-up-standees` | Full standee and base, with legible blank design area; hover shows base and carry case. | `hero`, `front`, `base-detail`, `carry-case`, `expo-scene`. |
| `fabric-expo-backdrops` | Installed full backdrop in a booth; hover is fabric close-up and frame detail. | `hero`, `full-front`, `fabric-detail`, `frame-detail`, `expo-scene`. |
| `exhibition-booth-panels` | Finished modular booth panels with wide but uncluttered perspective; hover shows panel join. | `hero`, `panel-detail`, `assembled-booth`, `expo-scene`. |
| `branded-table-covers` | Front-facing dressed table at a registration area; hover shows fabric drape. | `hero`, `front`, `fabric-detail`, `table-scene`. |
| `brochure-display-stands` | Open display stand with printed literature at a booth; hover shows pocket construction. | `hero`, `front`, `open`, `pockets-detail`, `expo-scene`. |

## Custom Apparel

**Photography direction:** this is the highest priority product category. Use true garment photography with correct stitching, drape, fabric weight, and realistic folds. Photograph each colour separately against consistent studio lighting. Use a diverse, natural model only for lifestyle images.

| Product ID | Primary and hover direction | Required gallery / detail views |
| --- | --- | --- |
| `embroidered-polo-shirts` | Navy polo front as default; hover is navy back/angle. | Root `primary`, `hover`, `featured`, plus `navy`, `white`, `black`, and `grey`: `front`, `back`, `folded`, `lifestyle`, `detail` galleries. Detail must show embroidery. |
| `custom-tshirts` | White round-neck front as default; hover is a black angle. | Root `primary`, `hover`, plus `white`, `black`, `navy`, and `red`: `front`, `back`, `folded`, `lifestyle`, `detail` galleries. Detail must show print texture. |
| `custom-sports-jerseys` | Blue jersey front as default with credible name/number area; hover is blue back. | Root `primary`, `hover`, plus `blue`, `white`, `red`, and `yellow`: `front`, `back`, `folded`, `lifestyle`, `detail` galleries. Detail must show number/heat-transfer finish. |
| `corporate-uniforms` | Coordinated uniform front as default; hover presents a small team in work context. | `hero`, `shirt-front`, `shirt-back`, `polo-front`, `team-scene`, `embroidery-detail`, `folded`. |
| `premium-cotton-hoodies` | Black hoodie front as default; hover is black back. | Root `primary`, `hover`, plus `black`, `grey`, and `navy`: `front`, `back`, `folded`, `lifestyle`, `detail` galleries. Detail shows print or embroidery. |
| `custom-sweatshirts` | Grey sweatshirt front as default; hover is black back. | Root `primary`, `hover`, plus `grey`, `black`, and `navy`: `front`, `back`, `folded`, `lifestyle`, `detail` galleries. |
| `oversized-tshirts` | White oversized shirt front as default; hover is black back/angle. | Root `primary`, `hover`, plus `white`, `black`, and `grey`: `front`, `back`, `folded`, `lifestyle`, `detail` galleries. |
| `custom-caps` | Black cap front as default; hover is a navy side view. | Root `primary`, `hover`, plus `black`, `navy`, and `white`: `front`, `side`, `back`, `lifestyle`, `detail` galleries. Detail must show embroidery. |
| `custom-apparel-tote-bags` | Natural tote front as default; hover is black tote at a 45-degree angle. | Root `primary`, `hover`, plus `natural`, `black`, and `navy`: `front`, `back`, `folded`, `lifestyle`, `detail` galleries. |
| `branded-aprons` | Black apron front as default; hover is a natural apron in a cafe/studio context. | Root `primary`, `hover`, plus `black`, `natural`, and `navy`: `front`, `back`, `folded`, `lifestyle`, `detail` galleries. |

## Personalised Gifts

**Photography direction:** warm, believable home and desk environments with tasteful personal moments. Never show distorted faces, illegible personal text, or fabricated branded-device interfaces.

| Product ID | Primary and hover direction | Required gallery / detail views |
| --- | --- | --- |
| `photo-mugs` | White ceramic mug at 45 degrees with a clean, photographic sample print; hover shows the handle. | `hero`, `front`, `side`, `handle-detail`, `gift-box`, `lifestyle-01`, `featured`. |
| `personalised-photo-frames` | Frame front on a contemporary desk; hover shows the rear stand or a wall scene. | `hero`, `front`, `back`, `desk-scene`, `wall-scene`, `corner-detail`. |
| `magic-photo-mugs` | Cold dark mug as default; hover shows the warm reveal from the same session. | `hero`, `cold`, `warm-reveal`, `handle-detail`, `lifestyle-01`. |
| `personalised-photo-albums` | Album cover front with a believable image area; hover is a layflat interior. | `hero`, `cover`, `open-spread`, `spine-detail`, `lifestyle-01`, `gift-box`. |
| `personalised-calendars` | Desk calendar front as default; hover is a wall calendar or open month. | `hero`, `cover`, `open-month`, `desk-scene`, `wall-scene`. |
| `personalised-wall-clocks` | Clock front on an airy wall; hover shows the shallow edge and room context. | `hero`, `front`, `edge-detail`, `wall-scene`, `back`. |
| `custom-mouse-pads` | Mouse pad overhead on a clean working desk; hover is edge material detail. | `hero`, `top-view`, `edge-detail`, `desk-scene`, `rolled`. |
| `custom-photo-magnets` | Small curated set as default; hover is a magnet in use on a fridge. | `hero`, `set`, `fridge-scene`, `detail-01`, `packaging`. |
| `photo-keychains` | Keychain front on a soft studio surface; hover is reverse/metal-edge detail. | `hero`, `front`, `back`, `metal-detail`, `lifestyle-01`, `gift-box`. |
| `photo-cushions` | Cushion front in a contemporary living space; hover shows fabric texture. | `hero`, `front`, `back`, `fabric-detail`, `room-scene`. |
| `custom-canvas-prints` | Canvas front as a styled wall scene; hover shows the wrapped edge and close texture. | `hero`, `front`, `edge-detail`, `closeup-01`, `wall-scene`. |
| `acrylic-photo-blocks` | Acrylic block three-quarter desk shot; hover shows transparent edge/reflection. | `hero`, `front`, `side`, `edge-detail`, `desk-scene`, `gift-box`. |

## Image-Usage Plan

Use existing placement preference rather than creating one-off assets:

| Surface | Asset preference |
| --- | --- |
| Category page header | `categories/<category>/hero.webp` |
| Shop by Category | `categories/<category>/cover.webp` |
| Product listing, search, cart, wishlist | `primary.webp` |
| Product-card interaction | `hover.webp`, then `primary.webp` fallback |
| Product page | `primary.webp` and the full folder gallery |
| Most Loved / Featured | Existing `featured.webp`, otherwise primary |
| Recommendations and related products | `recommendation.webp`, otherwise primary |
| Homepage editorial treatment | Category hero or existing product `hero.webp` / `featured.webp`; do not create homepage-only duplicate artwork |

## Production QA Checklist

- Verify every requested path matches the exact product ID shown in this document and in `IMAGE_ASSET_MANIFEST.md`.
- Verify `primary.webp` and `hover.webp` retain the same product, finish, colour, and scale.
- Verify garment, bottle, tote, pen, mug, notebook, and sleeve variants use truly different photographs rather than colour overlays.
- Verify no photo contains random or malformed text, incorrect hands, implausible folds, broken geometry, or invented third-party branding.
- Verify primary images remain readable at a small product-card size and lifestyle images retain a clearly identifiable product.
- Use `featured.webp` only where explicitly listed, and only when the composition adds value over the primary asset.
- Confirm all files are WebP and every product with a single supplied image still safely falls back through the Phase A resolver.

## Phase B Completion Boundary

This document is an asset specification only. Image generation, import, image-to-product association, and colour-selection UI bindings are deliberately separate Phase B execution work. No existing application behaviour changes as a result of this document.
