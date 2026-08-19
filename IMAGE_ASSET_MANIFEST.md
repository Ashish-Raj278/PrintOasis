# PrintOasis Image Asset Manifest

This is the Phase B production plan for catalog imagery. It deliberately contains no assets. Every path is relative to `public/assets/images/products/<category-slug>/<product-slug>/` and every new asset is WebP.

## Library Contract

- `primary.webp` is the default image for the product page and product cards.
- `hover.webp` is the optional alternate image for a product card. It falls back to `primary.webp` when absent.
- Every supported image in a product folder is available to the product-page gallery; use descriptive lowercase kebab-case names.
- `featured.webp`, `trending.webp`, and `recommendation.webp` are optional section-specific card images. They allow the same product to look appropriate on different homepage sections without replacing its primary image.
- Existing JPG, JPEG, and PNG uploads remain valid. Future AVIF support is already isolated in the resolver's preferred-format list.

## Folder Hierarchy

```text
public/assets/images/
  home/
  categories/<category-slug>/
  products/
    business-cards/<product-slug>/
    marketing/<product-slug>/
    corporate-gifting/<product-slug>/
    expo-materials/<product-slug>/
    packaging/<product-slug>/
    signage/<product-slug>/
    apparel/<product-slug>/
    gifts/<product-slug>/
    stationery/<product-slug>/
    same-day/<product-slug>/
    bulk/<product-slug>/
```

The category slugs above intentionally match the existing catalog and routes. Each category may additionally receive `hero.webp`, `cover.webp`, and `featured.webp` under `categories/<category-slug>/`. Homepage hero slots are `home/hero-business-cards.webp`, `home/hero-custom-apparel.webp`, and `home/hero-marketing-materials.webp`.

## Usage Map

| Asset | Usage |
| --- | --- |
| `primary.webp` | Product page, category grid, search, cart, wishlist, related products fallback |
| `hover.webp` | Product-card hover and keyboard-focus state |
| `featured.webp` | Most Loved Prints / featured-product carousel |
| `trending.webp` | Future trending-product placement |
| `recommendation.webp` | Related products and recommendations |
| `hero.webp` | Category landing banner when placed under `categories/<category>/` |
| `cover.webp` | Reserved category-cover usage |
| `angle-*`, `detail-*`, `stack-*`, `inside-*`, `lifestyle-*`, variants | Product-page gallery thumbnails and switching |

## Business Cards

### Square Business Cards (`business-cards/classic-business-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `stack-01.webp`, `detail-01.webp`, `lifestyle-01.webp`

### Raised Foil Business Cards (`business-cards/premium-foil-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `foil-detail-01.webp`, `texture-01.webp`, `stack-01.webp`, `lifestyle-01.webp`

### Spot UV Business Cards (`business-cards/spot-uv-business-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `spot-uv-detail-01.webp`, `stack-01.webp`, `lifestyle-01.webp`

### Standard Business Cards (`business-cards/standard-business-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `stack-01.webp`, `closeup-01.webp`, `lifestyle-01.webp`

### Premium Business Cards (`business-cards/premium-business-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `stack-01.webp`, `edge-detail-01.webp`, `lifestyle-01.webp`, `featured.webp`

### Matte Business Cards (`business-cards/matte-business-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `matte-detail-01.webp`, `stack-01.webp`

### Gloss Business Cards (`business-cards/gloss-business-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `gloss-detail-01.webp`, `stack-01.webp`

### Textured Business Cards (`business-cards/textured-business-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `texture-01.webp`, `texture-02.webp`, `stack-01.webp`

### Transparent Business Cards (`business-cards/transparent-business-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `transparent-detail-01.webp`, `stack-01.webp`, `lifestyle-01.webp`

### Eco-Friendly Business Cards (`business-cards/eco-friendly-business-cards`)
- `primary.webp`, `hover.webp`, `angle-01.webp`, `kraft-texture-01.webp`, `stack-01.webp`, `lifestyle-01.webp`

## Marketing Materials

### Premium Folded Brochures (`marketing/folded-brochures`)
- `primary.webp`, `hover.webp`, `open-spread.webp`, `folded.webp`, `detail-01.webp`, `lifestyle-01.webp`

### Presentation Folders (`marketing/event-posters`)
- `primary.webp`, `hover.webp`, `open.webp`, `inside-pocket.webp`, `stack-01.webp`, `lifestyle-01.webp`

### Professional Flyers (`marketing/professional-flyers`)
- `primary.webp`, `hover.webp`, `stack-01.webp`, `closeup-01.webp`, `lifestyle-01.webp`, `featured.webp`

### Marketing Booklets (`marketing/marketing-booklets`)
- `primary.webp`, `hover.webp`, `cover.webp`, `open-spread.webp`, `stack-01.webp`, `lifestyle-01.webp`

### Promotional Leaflets (`marketing/promotional-leaflets`)
- `primary.webp`, `hover.webp`, `stack-01.webp`, `detail-01.webp`, `lifestyle-01.webp`

### Product Catalogues (`marketing/product-catalogues`)
- `primary.webp`, `hover.webp`, `cover.webp`, `open-spread.webp`, `spine-detail.webp`, `lifestyle-01.webp`

### Printed Door Hangers (`marketing/printed-door-hangers`)
- `primary.webp`, `hover.webp`, `front-back.webp`, `die-cut-detail.webp`, `lifestyle-01.webp`

### Restaurant Menus (`marketing/restaurant-menus`)
- `primary.webp`, `hover.webp`, `open-spread.webp`, `table-scene.webp`, `lamination-detail.webp`

### Promotional Postcards (`marketing/promotional-postcards`)
- `primary.webp`, `hover.webp`, `front-back.webp`, `stack-01.webp`, `lifestyle-01.webp`

### Table Tent Cards (`marketing/table-tent-cards`)
- `primary.webp`, `hover.webp`, `front.webp`, `table-scene.webp`, `fold-detail.webp`

## Corporate Gifting

### Employee Welcome Kits (`corporate-gifting/employee-welcome-kits`)
- `primary.webp`, `hover.webp`, `flatlay.webp`, `open-box.webp`, `contents.webp`, `lifestyle-01.webp`, `featured.webp`

### Corporate Gift Hampers (`corporate-gifting/corporate-gift-hampers`)
- `primary.webp`, `hover.webp`, `open.webp`, `contents.webp`, `ribbon-detail.webp`, `lifestyle-01.webp`

### Corporate Polo T-Shirts (`corporate-gifting/corporate-polo-tshirts`)
- `primary.webp` (navy front), `hover.webp` (navy back), `navy-front.webp`, `navy-back.webp`, `white-front.webp`, `black-front.webp`, `grey-front.webp`, `folded.webp`, `embroidery-detail.webp`, `model.webp`

### Corporate Round Neck T-Shirts (`corporate-gifting/corporate-round-neck-tshirts`)
- `primary.webp` (white front), `hover.webp` (black front), `white-front.webp`, `black-front.webp`, `navy-front.webp`, `grey-front.webp`, `folded.webp`, `print-detail.webp`, `model.webp`

### Corporate Hoodies (`corporate-gifting/corporate-hoodies`)
- `primary.webp` (black front), `hover.webp` (grey front), `black-front.webp`, `grey-front.webp`, `navy-front.webp`, `black-back.webp`, `folded.webp`, `print-detail.webp`, `model.webp`

### Executive Diaries (`corporate-gifting/executive-diaries`)
- `primary.webp`, `hover.webp`, `cover-detail.webp`, `open-spread.webp`, `desk-scene.webp`, `gift-box.webp`

### Premium Executive Pens (`corporate-gifting/premium-executive-pens`)
- `primary.webp`, `hover.webp`, `engraving-detail.webp`, `gift-box.webp`, `desk-scene.webp`

### Stainless Steel Water Bottles (`corporate-gifting/stainless-steel-water-bottles`)
- `primary.webp` (silver), `hover.webp` (black), `silver-front.webp`, `black-front.webp`, `white-front.webp`, `blue-front.webp`, `side.webp`, `engraving-detail.webp`, `lifestyle-01.webp`

### Branded Laptop Sleeves (`corporate-gifting/branded-laptop-sleeves`)
- `primary.webp`, `hover.webp`, `open.webp`, `zipper-detail.webp`, `laptop-inserted.webp`, `lifestyle-01.webp`

### Corporate Branded Tote Bags (`corporate-gifting/corporate-tote-bags`)
- `primary.webp` (natural), `hover.webp` (black), `natural-front.webp`, `black-front.webp`, `navy-front.webp`, `side.webp`, `folded.webp`, `lifestyle-01.webp`

## Expo Materials

### Expo Welcome Kits (`expo-materials/expo-welcome-kits`)
- `primary.webp`, `hover.webp`, `flatlay.webp`, `open-box.webp`, `contents.webp`, `booth-scene.webp`, `featured.webp`

### Expo Roll-Up Standees (`expo-materials/expo-roll-up-standees`)
- `primary.webp`, `hover.webp`, `front.webp`, `base-detail.webp`, `carry-case.webp`, `expo-scene.webp`

### Fabric Expo Backdrops (`expo-materials/fabric-expo-backdrops`)
- `primary.webp`, `hover.webp`, `full-front.webp`, `fabric-detail.webp`, `frame-detail.webp`, `expo-scene.webp`

### Exhibition Booth Panels (`expo-materials/exhibition-booth-panels`)
- `primary.webp`, `hover.webp`, `panel-detail.webp`, `assembled-booth.webp`, `expo-scene.webp`

### Branded Table Covers (`expo-materials/branded-table-covers`)
- `primary.webp`, `hover.webp`, `front.webp`, `fabric-detail.webp`, `table-scene.webp`

### Brochure Display Stands (`expo-materials/brochure-display-stands`)
- `primary.webp`, `hover.webp`, `open.webp`, `pockets-detail.webp`, `expo-scene.webp`

## Labels & Packaging

### Custom Die-Cut Stickers (`packaging/die-cut-stickers`)
- `primary.webp`, `hover.webp`, `sheet.webp`, `peel-detail.webp`, `stack-01.webp`, `lifestyle-01.webp`

### Custom Printed Mailer Boxes (`packaging/mailer-boxes`)
- `primary.webp`, `hover.webp`, `closed.webp`, `open.webp`, `inside.webp`, `stack-01.webp`, `lifestyle-01.webp`, `featured.webp`

### Product Label Rolls (`packaging/product-label-rolls`)
- `primary.webp`, `hover.webp`, `roll-closeup.webp`, `applied.webp`, `stack-01.webp`

### Packaging Labels (`packaging/packaging-labels`)
- `primary.webp`, `hover.webp`, `sheet.webp`, `applied.webp`, `detail-01.webp`

### Shipping Labels (`packaging/shipping-labels`)
- `primary.webp`, `hover.webp`, `applied-parcel.webp`, `roll.webp`, `detail-01.webp`

### Sticker Sheets (`packaging/sticker-sheets`)
- `primary.webp`, `hover.webp`, `sheet-closeup.webp`, `peel-detail.webp`, `stack-01.webp`

### Custom Stickers (`packaging/custom-stickers`)
- `primary.webp`, `hover.webp`, `shape-01.webp`, `shape-02.webp`, `applied.webp`, `stack-01.webp`

### Printed Hang Tags (`packaging/printed-hang-tags`)
- `primary.webp`, `hover.webp`, `front-back.webp`, `string-detail.webp`, `attached.webp`

### Corrugated Shipping Boxes (`packaging/corrugated-shipping-boxes`)
- `primary.webp`, `hover.webp`, `closed.webp`, `open.webp`, `inside.webp`, `stack-01.webp`, `lifestyle-01.webp`

### Rigid Gift Boxes (`packaging/rigid-gift-boxes`)
- `primary.webp`, `hover.webp`, `closed.webp`, `open.webp`, `inside.webp`, `ribbon-detail.webp`, `lifestyle-01.webp`

### Printed Folding Cartons (`packaging/folding-cartons`)
- `primary.webp`, `hover.webp`, `flat.webp`, `assembled.webp`, `open.webp`, `stack-01.webp`

### Custom Product Boxes (`packaging/custom-product-boxes`)
- `primary.webp`, `hover.webp`, `closed.webp`, `open.webp`, `inside.webp`, `lifestyle-01.webp`

### Courier Boxes (`packaging/courier-boxes`)
- `primary.webp`, `hover.webp`, `closed.webp`, `open.webp`, `stack-01.webp`, `dispatch-scene.webp`

### Printed Pizza Boxes (`packaging/pizza-boxes`)
- `primary.webp`, `hover.webp`, `closed.webp`, `open.webp`, `inside.webp`, `stack-01.webp`

### Printed Sweet Boxes (`packaging/sweet-boxes`)
- `primary.webp`, `hover.webp`, `closed.webp`, `open.webp`, `inside.webp`, `gift-scene.webp`

### Bottle Packaging Boxes (`packaging/bottle-packaging-boxes`)
- `primary.webp`, `hover.webp`, `closed.webp`, `open.webp`, `inside.webp`, `bottle-inserted.webp`

### Kraft Paper Bags (`packaging/kraft-paper-bags`)
- `primary.webp`, `hover.webp`, `front.webp`, `side.webp`, `handle-detail.webp`, `lifestyle-01.webp`

### Printed Paper Carry Bags (`packaging/printed-paper-carry-bags`)
- `primary.webp`, `hover.webp`, `front.webp`, `side.webp`, `handle-detail.webp`, `lifestyle-01.webp`

### Printed Cotton Tote Bags (`packaging/packaging-tote-bags`)
- `primary.webp` (natural), `hover.webp` (black), `natural-front.webp`, `black-front.webp`, `navy-front.webp`, `folded.webp`, `lifestyle-01.webp`

### Packaging Sleeves (`packaging/packaging-sleeves`)
- `primary.webp`, `hover.webp`, `flat.webp`, `applied.webp`, `detail-01.webp`, `stack-01.webp`

### Printed Packaging Tape (`packaging/printed-packaging-tape`)
- `primary.webp`, `hover.webp`, `roll.webp`, `applied-parcel.webp`, `closeup-01.webp`

## Signage & Displays

### Premium Roll-Up Standees (`signage/roll-up-standees`)
- `primary.webp`, `hover.webp`, `front.webp`, `base-detail.webp`, `carry-case.webp`, `event-scene.webp`, `featured.webp`

### Fabric & Vinyl Banners (`signage/vinyl-banners`)
- `primary.webp`, `hover.webp`, `fabric-detail.webp`, `vinyl-detail.webp`, `mounted.webp`, `event-scene.webp`

### Acrylic Reception Signs (`signage/acrylic-signage`)
- `primary.webp`, `hover.webp`, `front.webp`, `edge-detail.webp`, `wall-mounted.webp`, `office-scene.webp`

### Flex Banners (`signage/flex-banners`)
- `primary.webp`, `hover.webp`, `closeup-01.webp`, `mounted.webp`, `event-scene.webp`

### Foam Display Boards (`signage/foam-display-boards`)
- `primary.webp`, `hover.webp`, `edge-detail.webp`, `mounted.webp`, `retail-scene.webp`

### LED Sign Boards (`signage/led-sign-boards`)
- `primary.webp`, `hover.webp`, `lit.webp`, `side.webp`, `wall-mounted.webp`, `night-scene.webp`

### Canvas Sign Prints (`signage/canvas-sign-prints`)
- `primary.webp`, `hover.webp`, `texture-01.webp`, `edge-detail.webp`, `wall-scene.webp`

### X-Banners (`signage/x-banners`)
- `primary.webp`, `hover.webp`, `front.webp`, `stand-detail.webp`, `carry-case.webp`, `event-scene.webp`

### Reception Signs (`signage/reception-signs`)
- `primary.webp`, `hover.webp`, `front.webp`, `wall-mounted.webp`, `office-scene.webp`

### Display Boards (`signage/display-boards`)
- `primary.webp`, `hover.webp`, `front.webp`, `edge-detail.webp`, `retail-scene.webp`

## Custom Apparel

### Custom Round Neck T-Shirts (`apparel/custom-tshirts`)
- `primary.webp` (white front), `hover.webp` (black front), `white-front.webp`, `black-front.webp`, `blue-front.webp`, `grey-front.webp`, `red-front.webp`, `back.webp`, `folded.webp`, `model.webp`, `print-detail.webp`

### Premium Cotton Hoodies (`apparel/premium-cotton-hoodies`)
- `primary.webp` (black front), `hover.webp` (grey front), `black-front.webp`, `grey-front.webp`, `navy-front.webp`, `black-back.webp`, `folded.webp`, `model.webp`, `print-detail.webp`

### Corporate Polo T-Shirts (`apparel/embroidered-polo-shirts`)
- `primary.webp` (navy front), `hover.webp` (white front), `navy-front.webp`, `white-front.webp`, `black-front.webp`, `grey-front.webp`, `back.webp`, `folded.webp`, `model.webp`, `embroidery-detail.webp`, `featured.webp`

### Oversized T-Shirts (`apparel/oversized-tshirts`)
- `primary.webp` (white front), `hover.webp` (black front), `white-front.webp`, `black-front.webp`, `grey-front.webp`, `back.webp`, `folded.webp`, `model.webp`, `print-detail.webp`

### Custom Sweatshirts (`apparel/custom-sweatshirts`)
- `primary.webp` (grey front), `hover.webp` (black front), `grey-front.webp`, `black-front.webp`, `navy-front.webp`, `back.webp`, `folded.webp`, `model.webp`, `print-detail.webp`

### Custom Sports Jerseys (`apparel/custom-sports-jerseys`)
- `primary.webp` (blue front), `hover.webp` (blue back), `blue-front.webp`, `blue-back.webp`, `white-front.webp`, `red-front.webp`, `number-detail.webp`, `model.webp`

### Corporate Uniforms (`apparel/corporate-uniforms`)
- `primary.webp`, `hover.webp`, `shirt-front.webp`, `shirt-back.webp`, `polo-front.webp`, `team-scene.webp`, `embroidery-detail.webp`

### Custom Caps (`apparel/custom-caps`)
- `primary.webp` (black), `hover.webp` (navy), `black-front.webp`, `navy-front.webp`, `white-front.webp`, `side.webp`, `embroidery-detail.webp`, `lifestyle-01.webp`

### Custom Canvas Tote Bags (`apparel/custom-apparel-tote-bags`)
- `primary.webp` (natural), `hover.webp` (black), `natural-front.webp`, `black-front.webp`, `navy-front.webp`, `folded.webp`, `lifestyle-01.webp`

### Branded Aprons (`apparel/branded-aprons`)
- `primary.webp` (black), `hover.webp` (natural), `black-front.webp`, `natural-front.webp`, `navy-front.webp`, `folded.webp`, `model.webp`, `print-detail.webp`

## Personalised Gifts

### Personalised Photo Mugs (`gifts/photo-mugs`)
- `primary.webp`, `hover.webp`, `side.webp`, `handle-detail.webp`, `gift-box.webp`, `lifestyle-01.webp`, `featured.webp`

### Custom Canvas Prints (`gifts/custom-canvas-prints`)
- `primary.webp`, `hover.webp`, `edge-detail.webp`, `wall-scene.webp`, `closeup-01.webp`

### Acrylic Photo Blocks (`gifts/acrylic-photo-blocks`)
- `primary.webp`, `hover.webp`, `side.webp`, `edge-detail.webp`, `desk-scene.webp`

### Magic Photo Mugs (`gifts/magic-photo-mugs`)
- `primary.webp`, `hover.webp`, `cold.webp`, `warm-reveal.webp`, `handle-detail.webp`, `lifestyle-01.webp`

### Personalised Photo Frames (`gifts/personalised-photo-frames`)
- `primary.webp`, `hover.webp`, `front.webp`, `back.webp`, `desk-scene.webp`, `wall-scene.webp`

### Custom Mouse Pads (`gifts/custom-mouse-pads`)
- `primary.webp`, `hover.webp`, `top-view.webp`, `edge-detail.webp`, `desk-scene.webp`

### Photo Keychains (`gifts/photo-keychains`)
- `primary.webp`, `hover.webp`, `front-back.webp`, `metal-detail.webp`, `lifestyle-01.webp`

### Personalised Calendars (`gifts/personalised-calendars`)
- `primary.webp`, `hover.webp`, `cover.webp`, `open-month.webp`, `desk-scene.webp`, `wall-scene.webp`

### Custom Photo Magnets (`gifts/custom-photo-magnets`)
- `primary.webp`, `hover.webp`, `set.webp`, `fridge-scene.webp`, `detail-01.webp`

### Personalised Photo Albums (`gifts/personalised-photo-albums`)
- `primary.webp`, `hover.webp`, `cover.webp`, `open-spread.webp`, `spine-detail.webp`, `lifestyle-01.webp`

### Photo Cushions (`gifts/photo-cushions`)
- `primary.webp`, `hover.webp`, `front.webp`, `fabric-detail.webp`, `room-scene.webp`

### Personalised Wall Clocks (`gifts/personalised-wall-clocks`)
- `primary.webp`, `hover.webp`, `front.webp`, `edge-detail.webp`, `wall-scene.webp`

## Office Stationery

### Premium Company Letterheads (`stationery/letterheads`)
- `primary.webp`, `hover.webp`, `stack-01.webp`, `closeup-01.webp`, `desk-scene.webp`

### Branded Business Envelopes (`stationery/business-envelopes`)
- `primary.webp`, `hover.webp`, `front-back.webp`, `open.webp`, `stack-01.webp`, `desk-scene.webp`

### Presentation Folders (`stationery/presentation-folders`)
- `primary.webp`, `hover.webp`, `open.webp`, `inside-pocket.webp`, `stack-01.webp`, `desk-scene.webp`

### Invoice Books (`stationery/invoice-books`)
- `primary.webp`, `hover.webp`, `cover.webp`, `inside.webp`, `duplicate-detail.webp`, `desk-scene.webp`

### Branded Notebooks (`stationery/branded-notebooks`)
- `primary.webp`, `hover.webp`, `cover.webp`, `open-spread.webp`, `stack-01.webp`, `desk-scene.webp`

### Office Diaries (`stationery/office-diaries`)
- `primary.webp`, `hover.webp`, `cover.webp`, `open-spread.webp`, `spine-detail.webp`, `desk-scene.webp`

### Printed Certificates (`stationery/printed-certificates`)
- `primary.webp`, `hover.webp`, `foil-detail.webp`, `paper-detail.webp`, `framed.webp`

### Files & Folders (`stationery/files-and-folders`)
- `primary.webp`, `hover.webp`, `open.webp`, `spine.webp`, `stack-01.webp`, `office-scene.webp`

### Printed ID Cards (`stationery/printed-id-cards`)
- `primary.webp`, `hover.webp`, `front-back.webp`, `holder.webp`, `lanyard-detail.webp`

### Branded Lanyards (`stationery/branded-lanyards`)
- `primary.webp`, `hover.webp`, `flatlay.webp`, `clip-detail.webp`, `id-card-attached.webp`, `event-scene.webp`

## Same-Day Prints

### Same-Day Flyers (`same-day/express-flyers`)
- `primary.webp`, `hover.webp`, `stack-01.webp`, `closeup-01.webp`, `dispatch-scene.webp`

### Same-Day Business Cards (`same-day/same-day-business-cards`)
- `primary.webp`, `hover.webp`, `stack-01.webp`, `closeup-01.webp`, `dispatch-scene.webp`

### Same-Day Posters (`same-day/same-day-posters`)
- `primary.webp`, `hover.webp`, `mounted.webp`, `closeup-01.webp`, `dispatch-scene.webp`

### Same-Day Stickers (`same-day/same-day-stickers`)
- `primary.webp`, `hover.webp`, `sheet.webp`, `peel-detail.webp`, `dispatch-scene.webp`

### Same-Day X-Banners (`same-day/same-day-x-banners`)
- `primary.webp`, `hover.webp`, `front.webp`, `stand-detail.webp`, `dispatch-scene.webp`

## Bulk Printing

### Bulk Corporate Stationery (`bulk/bulk-corporate-stationery`)
- `primary.webp`, `hover.webp`, `flatlay.webp`, `stack-01.webp`, `office-scene.webp`, `featured.webp`

### Bulk Marketing Kits (`bulk/bulk-marketing-kits`)
- `primary.webp`, `hover.webp`, `flatlay.webp`, `contents.webp`, `stack-01.webp`, `campaign-scene.webp`

### Bulk Packaging Labels (`bulk/bulk-packaging-labels`)
- `primary.webp`, `hover.webp`, `rolls.webp`, `applied.webp`, `production-stack.webp`

### Bulk Business Cards (`bulk/bulk-business-cards`)
- `primary.webp`, `hover.webp`, `stack-01.webp`, `packaged.webp`, `production-scene.webp`

### Bulk Flyers (`bulk/bulk-flyers`)
- `primary.webp`, `hover.webp`, `stack-01.webp`, `packaged.webp`, `production-scene.webp`

### Bulk Brochures (`bulk/bulk-brochures`)
- `primary.webp`, `hover.webp`, `open-spread.webp`, `stack-01.webp`, `production-scene.webp`

### Bulk Packaging Boxes (`bulk/bulk-packaging-boxes`)
- `primary.webp`, `hover.webp`, `closed.webp`, `open.webp`, `stack-01.webp`, `warehouse-scene.webp`

### Bulk Paper Bags (`bulk/bulk-paper-bags`)
- `primary.webp`, `hover.webp`, `front.webp`, `stack-01.webp`, `warehouse-scene.webp`

### Bulk Cotton Tote Bags (`bulk/bulk-tote-bags`)
- `primary.webp` (natural), `hover.webp` (black), `natural-front.webp`, `black-front.webp`, `navy-front.webp`, `stack-01.webp`, `warehouse-scene.webp`

### Bulk T-Shirts (`bulk/bulk-tshirts`)
- `primary.webp` (white front), `hover.webp` (black front), `white-front.webp`, `black-front.webp`, `navy-front.webp`, `folded-stack.webp`, `production-scene.webp`

### Bulk Notebooks (`bulk/bulk-notebooks`)
- `primary.webp`, `hover.webp`, `cover.webp`, `stack-01.webp`, `production-scene.webp`

### Bulk Corporate Welcome Kits (`bulk/bulk-corporate-welcome-kits`)
- `primary.webp`, `hover.webp`, `flatlay.webp`, `contents.webp`, `stack-01.webp`, `warehouse-scene.webp`, `featured.webp`

## Phase B Acceptance Checklist

- Generate only the listed assets that make sense for the product; do not add filler views.
- Deliver each asset to its exact product folder with the listed filename.
- Use WebP with a crisp 4:3 primary crop and optimise for web delivery.
- Keep text-free product photography where possible so campaign copy can remain in HTML.
- Verify `primary.webp` first, then hover/card behavior, gallery order, category hero, and section-specific images.
