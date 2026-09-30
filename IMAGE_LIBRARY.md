# PrintOasis Image Library

New catalog imagery belongs under `public/assets/images`. The application prefers a WebP asset when it exists, then AVIF, JPG/JPEG, PNG and repository-authored SVG illustrations. Existing uploaded product images in `data/uploads/product-images` remain fully supported and are used when a library asset is absent. SVG support is for trusted source assets only; product-image uploads do not accept SVG.

## Product paths

Use one folder per product:

```text
public/assets/images/products/<category-slug>/<product-slug>/
```

For example:

```text
products/business-cards/standard-business-cards/primary.webp
products/business-cards/standard-business-cards/hover.webp
products/business-cards/standard-business-cards/gallery-01.webp
products/business-cards/standard-business-cards/angle-01.webp
products/apparel/corporate-polo-tshirts/front.webp
products/apparel/corporate-polo-tshirts/back.webp
products/apparel/corporate-polo-tshirts/lifestyle.webp
```

`primary.webp` is the default image. `hover.webp` is used on product cards when present. The product page reads every supported image in the folder into its gallery, ordered by filename. The following names are reserved for context-specific slots: `hero`, `card`, `featured`, `trending`, `recommendation`, and `lifestyle`. For example, `featured.webp` is used in the homepage featured-products carousel without affecting the normal card or product page image.

Use lowercase kebab-case names. Use two-digit sequencing for repeated views: `gallery-01.webp`, `gallery-02.webp`, `detail-01.webp`, `angle-01.webp`. Recommended visual names include `front`, `back`, `stack`, `closeup`, `texture`, `flatlay`, and `lifestyle`.

## Category and homepage paths

```text
public/assets/images/categories/<category-slug>/hero.webp
public/assets/images/categories/<category-slug>/cover.webp
public/assets/images/categories/<category-slug>/featured.webp
public/assets/images/home/hero-business-cards.webp
public/assets/images/home/hero-custom-apparel.webp
public/assets/images/home/hero-marketing-materials.webp
public/assets/images/home/hero-diwali-hamper.png
public/assets/images/products/gifts/printoasis-diwali-hamper-kit/primary.png
```

Category `hero.webp` is used on the existing category landing header. Homepage hero files replace their existing source images only when present, preserving the current fallback otherwise.

## Admin uploads

The existing primary image field remains the legacy-compatible primary upload. The admin product form also accepts one optional hover image and multiple gallery images. Gallery uploads can be assigned to the default product gallery or a featured, trending, or recommendation placement. No media manager or file migration is required.

## Delivery guidance

Use WebP for all new generated product assets. Export at an appropriate source size for the crop, keep the main product image close to 4:3, and avoid embedding text that must change between campaigns. The renderer reserves dimensions, uses lazy loading for non-critical images, and supports modern formats without changing existing JPG, JPEG, or PNG references.
