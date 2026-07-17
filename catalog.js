const categories = [
  ["business-cards", "Business Cards", "Premium cards that make every introduction count.", "BC"],
  ["marketing", "Marketing Prints", "Campaign-ready flyers, brochures and posters.", "MP"],
  ["packaging", "Labels & Packaging", "Thoughtful packaging for products, parcels and retail.", "LP"],
  ["signage", "Signage & Displays", "High-impact signage for stores, events and workspaces.", "SD"],
  ["apparel", "Custom Apparel", "Quality branded clothing for teams, events and retail.", "CA"],
  ["gifts", "Personalised Gifts", "Photo-led gifts, keepsakes and display pieces.", "PG"],
  ["stationery", "Office Stationery", "Branded essentials for professional everyday use.", "OS"],
  ["same-day", "Same-Day Prints", "Select print essentials produced in as little as four hours.", "4H"],
  ["bulk", "Bulk Printing", "Reliable volume printing for campaigns, teams and rollouts.", "BP"]
];

// Canonical PrintOasis catalog. Prices are INR for the listed minimum quantity.
const products = [
  ["classic-business-cards", "Soft Touch Business Cards", "business-cards", 499, 100, 4.8, "Popular", "Velvety soft-touch cards on premium 350 GSM stock with precise, rich colour.", "3.5 x 2 in|3.3 x 2.1 in", "Soft-touch|Matte|Uncoated", "Single-sided|Double-sided", "cobalt"],
  ["premium-foil-cards", "Raised Foil Business Cards", "business-cards", 999, 100, 4.9, "Recommended", "Luxurious thick cards with tactile raised gold or silver foil details.", "3.5 x 2 in", "Soft-touch|Textured", "Gold foil|Silver foil", "ink"],
  ["spot-uv-business-cards", "Spot UV Business Cards", "business-cards", 849, 100, 4.8, "", "Matte laminated cards with a high-gloss Spot UV accent for selective detail.", "3.5 x 2 in", "350 GSM matte laminated", "Single-sided|Double-sided", "ink"],

  ["folded-brochures", "Premium Folded Brochures", "marketing", 749, 50, 4.7, "Popular", "Crisp, professionally folded brochures for menus, launches and sales kits.", "A4 tri-fold|A4 bi-fold|A3 bi-fold", "130 GSM gloss|170 GSM matte", "Single-sided|Double-sided", "coral"],
  ["event-posters", "Premium Event Posters", "marketing", 299, 5, 4.6, "", "High-impact posters with rich colour, clean detail and dependable print consistency.", "A3|A2|A1", "170 GSM matte|200 GSM gloss", "Full colour", "yellow"],
  ["professional-flyers", "Professional Flyers", "marketing", 449, 50, 4.7, "Recommended", "Marketing flyers with vivid colour reproduction for promotions, menus and handouts.", "A5|A4|DL", "130 GSM gloss|170 GSM matte", "Single-sided|Double-sided", "coral"],

  ["die-cut-stickers", "Custom Die-Cut Stickers", "packaging", 499, 50, 4.9, "Popular", "Durable custom-shape stickers for products, parcels and branded packaging.", "2 in|3 in|4 in", "Gloss vinyl|Matte vinyl|Paper", "Kiss cut|Die cut", "mint"],
  ["mailer-boxes", "Custom Printed Mailer Boxes", "packaging", 1499, 25, 4.8, "New", "Sturdy corrugated mailer boxes designed for a memorable unboxing experience.", "8 x 6 x 3 in|10 x 8 x 4 in", "Kraft|White corrugated", "Outside print|Inside + outside", "coral"],
  ["product-label-rolls", "Product Label Rolls", "packaging", 699, 100, 4.7, "", "Professionally printed roll labels for jars, bottles, boxes and retail packs.", "2 in round|3 x 2 in|4 x 2 in", "Matte paper|Gloss paper|Waterproof vinyl", "Permanent adhesive", "yellow"],

  ["roll-up-standees", "Premium Roll-Up Standees", "signage", 1899, 1, 4.7, "Popular", "Portable, reusable displays with a premium base for retail and event spaces.", "2.5 x 6 ft|3 x 6 ft", "Premium flex|Fabric", "Stand included", "cobalt"],
  ["vinyl-banners", "Fabric & Vinyl Banners", "signage", 699, 1, 4.7, "", "Indoor and outdoor banners with crisp colour and reinforced finishing options.", "3 x 2 ft|6 x 3 ft|8 x 4 ft", "Fabric|440 GSM vinyl", "Eyelets|Pole pockets", "ink"],
  ["acrylic-signage", "Acrylic Reception Signs", "signage", 1299, 1, 4.8, "Recommended", "Clean, modern acrylic signs for reception desks, offices and storefronts.", "A4|A3|18 x 12 in", "Clear acrylic|Frosted acrylic", "Wall mounts|Desk stand-offs", "cobalt"],

  ["custom-tshirts", "Premium Cotton T-Shirts", "apparel", 599, 1, 4.8, "Popular", "Comfortable premium cotton T-shirts with vibrant, durable custom printing.", "S|M|L|XL|XXL", "White|Black|Navy|Red", "Front|Back|Front + back", "yellow"],
  ["premium-cotton-hoodies", "Premium Cotton Hoodies", "apparel", 1299, 1, 4.8, "Recommended", "Heavyweight branded hoodies finished with high-quality print or embroidery.", "S|M|L|XL|XXL", "Black|Navy|Charcoal", "Chest print|Embroidery|Back print", "ink"],
  ["embroidered-polo-shirts", "Embroidered Polo Shirts", "apparel", 849, 5, 4.7, "", "Smart, durable polos for uniforms, hospitality teams and corporate events.", "S|M|L|XL|XXL", "Cotton pique|Poly-cotton", "Left chest embroidery|Sleeve embroidery", "mint"],

  ["photo-mugs", "Personalised Photo Mugs", "gifts", 349, 1, 4.9, "Popular", "A personal ceramic photo mug with a bright, lasting full-wrap print.", "325 ml", "White ceramic|Magic mug", "Full wrap", "mint"],
  ["custom-canvas-prints", "Custom Canvas Prints", "gifts", 999, 1, 4.8, "Recommended", "Gallery-wrapped canvas prints for memorable photos, art and wall displays.", "8 x 8 in|12 x 18 in|18 x 24 in", "Matte canvas", "Gallery wrap", "coral"],
  ["acrylic-photo-blocks", "Acrylic Photo Blocks", "gifts", 799, 1, 4.7, "", "Crystal-clear acrylic blocks that turn favourite photographs into desk displays.", "4 x 4 in|6 x 4 in|8 x 6 in", "Clear acrylic", "Single-sided print", "cobalt"],

  ["letterheads", "Premium Company Letterheads", "stationery", 599, 100, 4.7, "", "Professional letterheads on smooth, writing-friendly premium stock.", "A4", "100 GSM bond|120 GSM premium", "Single-sided", "cobalt"],
  ["business-envelopes", "Branded Business Envelopes", "stationery", 699, 100, 4.7, "", "Professional envelopes for invoices, correspondence and corporate mailers.", "DL|C5|C4", "100 GSM bond|120 GSM premium", "Front print|Front + flap", "yellow"],
  ["presentation-folders", "Presentation Folders", "stationery", 1199, 25, 4.8, "Recommended", "Premium document folders with business card slots for meetings and proposals.", "A4", "300 GSM matte|350 GSM laminated", "Single-sided|Double-sided", "coral"],

  ["express-flyers", "Same-Day Flyers", "same-day", 499, 50, 4.6, "Popular", "Urgent flyers produced quickly without compromising colour or finish.", "A5|A4", "130 GSM gloss|170 GSM matte", "Single-sided|Double-sided", "coral"],
  ["same-day-business-cards", "Same-Day Business Cards", "same-day", 649, 100, 4.7, "", "Essential business cards produced on an accelerated schedule for urgent needs.", "3.5 x 2 in", "300 GSM matte|350 GSM gloss", "Single-sided|Double-sided", "cobalt"],
  ["same-day-posters", "Same-Day Posters", "same-day", 349, 5, 4.6, "", "Fast-turnaround posters for announcements, menus and event promotions.", "A3|A2", "170 GSM matte|200 GSM gloss", "Full colour", "yellow"],

  ["bulk-corporate-stationery", "Bulk Corporate Stationery", "bulk", 5499, 500, 4.8, "Recommended", "Coordinated high-volume business cards, letterheads and envelopes for teams.", "Custom bundle", "Premium paper stocks", "Brand-matched print", "cobalt"],
  ["bulk-marketing-kits", "Bulk Marketing Kits", "bulk", 8999, 250, 4.8, "", "Campaign-ready bulk flyers, brochures and posters with consistent brand colour.", "Custom bundle", "Marketing print stocks", "Mixed-format print", "coral"],
  ["bulk-packaging-labels", "Bulk Packaging Labels", "bulk", 3999, 1000, 4.7, "New", "High-volume labels for retail, FMCG and fulfilment operations.", "Custom size", "Paper|Vinyl|Waterproof film", "Roll labels", "mint"]
];

module.exports = { categories, products };
