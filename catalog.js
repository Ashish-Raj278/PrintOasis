const categories = [
  ["business-cards", "Business Cards", "Make every introduction count.", "BC"],
  ["marketing", "Marketing Prints", "Flyers, brochures and posters that get noticed.", "MP"],
  ["packaging", "Labels & Packaging", "Packaging that looks as good as what is inside.", "LP"],
  ["signage", "Signs & Displays", "Big, bold visibility for stores and events.", "SD"],
  ["apparel", "Custom Apparel", "Wear your team, event or brand.", "CA"],
  ["gifts", "Photo Gifts", "Personal pieces made for memorable moments.", "PG"],
  ["stationery", "Office Stationery", "Everyday essentials, consistently branded.", "OS"],
  ["same-day", "Same-day Prints", "Select essentials produced in as little as four hours.", "4H"]
];

// Edit products here. Prices are in INR for the listed minimum quantity.
const products = [
  ["classic-business-cards", "Classic Business Cards", "business-cards", 399, 100, 4.8, "Bestseller", "Premium 350 GSM cards with sharp, confident color.", "3.5 x 2 in|3.3 x 2.1 in", "Matte|Gloss|Uncoated|Textured", "Single-sided|Double-sided", "cobalt"],
  ["premium-foil-cards", "Premium Foil Cards", "business-cards", 899, 100, 4.9, "Premium", "Thick cards finished with elegant gold or silver foil.", "3.5 x 2 in", "Soft-touch|Textured", "Gold foil|Silver foil", "ink"],
  ["folded-brochures", "Folded Brochures", "marketing", 749, 50, 4.7, "Popular", "Crisp brochures for menus, launches and sales kits.", "A4 tri-fold|A4 bi-fold|A3 bi-fold", "130 GSM gloss|170 GSM matte", "Single-sided|Double-sided", "coral"],
  ["event-posters", "Event Posters", "marketing", 299, 5, 4.6, "Same day", "High-impact posters with rich color and clean detail.", "A3|A2|A1", "170 GSM matte|200 GSM gloss", "Full color", "yellow"],
  ["die-cut-stickers", "Die-cut Stickers", "packaging", 499, 50, 4.9, "Bestseller", "Durable custom-shape stickers for products and parcels.", "2 in|3 in|4 in", "Gloss vinyl|Matte vinyl|Paper", "Kiss cut|Die cut", "mint"],
  ["mailer-boxes", "Printed Mailer Boxes", "packaging", 1499, 25, 4.8, "New", "Sturdy corrugated boxes printed to deliver a strong unboxing.", "8 x 6 x 3 in|10 x 8 x 4 in", "Kraft|White corrugated", "Outside print|Inside + outside", "coral"],
  ["roll-up-standees", "Roll-up Standees", "signage", 1899, 1, 4.7, "Popular", "Portable, reusable displays for retail and events.", "2.5 x 6 ft|3 x 6 ft", "Premium flex|Fabric", "Stand included", "cobalt"],
  ["vinyl-banners", "Vinyl Banners", "signage", 599, 1, 4.6, "Outdoor", "Weather-ready banners with reinforced eyelets.", "3 x 2 ft|6 x 3 ft|8 x 4 ft", "440 GSM vinyl", "Indoor|Outdoor", "ink"],
  ["custom-tshirts", "Custom T-shirts", "apparel", 549, 1, 4.8, "From 1 piece", "Comfortable cotton tees with vibrant custom printing.", "S|M|L|XL|XXL", "White|Black|Navy|Red", "Front|Back|Front + back", "yellow"],
  ["photo-mugs", "Photo Mugs", "gifts", 349, 1, 4.9, "Gift favourite", "A personal photo mug with a bright, lasting print.", "325 ml", "White ceramic|Magic mug", "Full wrap", "mint"],
  ["letterheads", "Company Letterheads", "stationery", 599, 100, 4.7, "Business", "Professional letterheads on smooth writing-friendly stock.", "A4", "100 GSM bond|120 GSM premium", "Single-sided", "cobalt"],
  ["express-flyers", "Express Flyers", "same-day", 449, 50, 4.6, "4-hour delivery", "Urgent flyers produced quickly without compromising color.", "A5|A4", "130 GSM gloss|170 GSM matte", "Single-sided|Double-sided", "coral"]
];

module.exports = { categories, products };
