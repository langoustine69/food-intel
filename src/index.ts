import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';

const agent = await createAgent({
  name: 'food-intel',
  version: '1.0.0',
  description: 'Food & nutrition intelligence - barcode lookup, product search, nutritional data via Open Food Facts',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === API Helper ===
const OFF_BASE = 'https://world.openfoodfacts.org';

async function fetchOFF(path: string) {
  const url = `${OFF_BASE}${path}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'food-intel-agent/1.0' }
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

function extractProduct(product: any) {
  if (!product) return null;
  return {
    code: product.code || product._id,
    name: product.product_name || 'Unknown',
    brand: product.brands || 'Unknown',
    categories: product.categories || '',
    nutriscore: product.nutriscore_grade || null,
    novaGroup: product.nova_group || null,
    ecoscore: product.ecoscore_grade || null,
    ingredients: product.ingredients_text || '',
    allergens: product.allergens || '',
    imageUrl: product.image_url || null,
    nutrition100g: product.nutriments ? {
      energy_kcal: product.nutriments['energy-kcal_100g'],
      fat: product.nutriments.fat_100g,
      saturatedFat: product.nutriments['saturated-fat_100g'],
      carbohydrates: product.nutriments.carbohydrates_100g,
      sugars: product.nutriments.sugars_100g,
      fiber: product.nutriments.fiber_100g,
      proteins: product.nutriments.proteins_100g,
      salt: product.nutriments.salt_100g,
      sodium: product.nutriments.sodium_100g,
    } : null,
  };
}

// === FREE: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of food-intel capabilities - try before you buy',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    // Get a sample product to show the API works
    const data = await fetchOFF('/api/v0/product/3017620422003.json');
    return {
      output: {
        agent: 'food-intel',
        description: 'Food & nutrition intelligence powered by Open Food Facts',
        dataSource: 'Open Food Facts (live)',
        sampleProduct: extractProduct(data.product),
        endpoints: [
          { key: 'barcode', price: '$0.001', description: 'Lookup product by barcode' },
          { key: 'search', price: '$0.002', description: 'Search products by name' },
          { key: 'category', price: '$0.002', description: 'Get products in a category' },
          { key: 'brand', price: '$0.002', description: 'Get products by brand' },
          { key: 'nutrition', price: '$0.003', description: 'Detailed nutrition analysis' },
        ],
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID: Barcode Lookup ($0.001) ===
addEntrypoint({
  key: 'barcode',
  description: 'Look up a food product by barcode (EAN/UPC)',
  input: z.object({ 
    barcode: z.string().describe('Product barcode (EAN-13, UPC-A, etc.)') 
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const data = await fetchOFF(`/api/v0/product/${ctx.input.barcode}.json`);
    if (data.status !== 1) {
      return { output: { found: false, barcode: ctx.input.barcode, message: 'Product not found' } };
    }
    return { 
      output: { 
        found: true,
        product: extractProduct(data.product),
        fetchedAt: new Date().toISOString()
      } 
    };
  },
});

// === PAID: Search ($0.002) ===
addEntrypoint({
  key: 'search',
  description: 'Search products by name or keyword',
  input: z.object({ 
    query: z.string().describe('Search term (product name, ingredient, etc.)'),
    limit: z.number().min(1).max(50).optional().default(10)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const params = new URLSearchParams({
      search_terms: ctx.input.query,
      json: '1',
      page_size: String(ctx.input.limit),
    });
    const data = await fetchOFF(`/cgi/search.pl?${params}`);
    const products = (data.products || []).map(extractProduct).filter(Boolean);
    return { 
      output: { 
        query: ctx.input.query,
        count: data.count || 0,
        products,
        fetchedAt: new Date().toISOString()
      } 
    };
  },
});

// === PAID: Category ($0.002) ===
addEntrypoint({
  key: 'category',
  description: 'Get products in a food category',
  input: z.object({ 
    category: z.string().describe('Category slug (e.g., "chocolates", "beverages", "cereals")'),
    limit: z.number().min(1).max(50).optional().default(10)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const slug = ctx.input.category.toLowerCase().replace(/\s+/g, '-');
    const data = await fetchOFF(`/category/${slug}.json`);
    const products = (data.products || []).slice(0, ctx.input.limit).map(extractProduct).filter(Boolean);
    return { 
      output: { 
        category: ctx.input.category,
        count: data.count || 0,
        products,
        fetchedAt: new Date().toISOString()
      } 
    };
  },
});

// === PAID: Brand ($0.002) ===
addEntrypoint({
  key: 'brand',
  description: 'Get products from a specific brand',
  input: z.object({ 
    brand: z.string().describe('Brand name (e.g., "Coca-Cola", "Nestle", "Kelloggs")'),
    limit: z.number().min(1).max(50).optional().default(10)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const slug = ctx.input.brand.toLowerCase().replace(/\s+/g, '-');
    const data = await fetchOFF(`/brand/${slug}.json`);
    const products = (data.products || []).slice(0, ctx.input.limit).map(extractProduct).filter(Boolean);
    return { 
      output: { 
        brand: ctx.input.brand,
        count: data.count || 0,
        products,
        fetchedAt: new Date().toISOString()
      } 
    };
  },
});

// === PAID: Nutrition Analysis ($0.003) ===
addEntrypoint({
  key: 'nutrition',
  description: 'Detailed nutrition analysis for a product with health scores',
  input: z.object({ 
    barcode: z.string().describe('Product barcode') 
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const data = await fetchOFF(`/api/v0/product/${ctx.input.barcode}.json`);
    if (data.status !== 1) {
      return { output: { found: false, barcode: ctx.input.barcode, message: 'Product not found' } };
    }
    const p = data.product;
    return { 
      output: { 
        found: true,
        barcode: ctx.input.barcode,
        name: p.product_name || 'Unknown',
        brand: p.brands || 'Unknown',
        servingSize: p.serving_size || null,
        healthScores: {
          nutriscore: {
            grade: p.nutriscore_grade || null,
            score: p.nutriscore_score || null,
          },
          nova: {
            group: p.nova_group || null,
            groupName: p.nova_groups || null,
          },
          ecoscore: {
            grade: p.ecoscore_grade || null,
            score: p.ecoscore_score || null,
          },
        },
        nutrition100g: p.nutriments ? {
          energy_kj: p.nutriments['energy_100g'],
          energy_kcal: p.nutriments['energy-kcal_100g'],
          fat: p.nutriments.fat_100g,
          saturatedFat: p.nutriments['saturated-fat_100g'],
          carbohydrates: p.nutriments.carbohydrates_100g,
          sugars: p.nutriments.sugars_100g,
          fiber: p.nutriments.fiber_100g,
          proteins: p.nutriments.proteins_100g,
          salt: p.nutriments.salt_100g,
          sodium: p.nutriments.sodium_100g,
          calcium: p.nutriments.calcium_100g,
          iron: p.nutriments.iron_100g,
          vitaminA: p.nutriments['vitamin-a_100g'],
          vitaminC: p.nutriments['vitamin-c_100g'],
        } : null,
        nutritionPerServing: p.nutriments && p.serving_size ? {
          energy_kcal: p.nutriments['energy-kcal_serving'],
          fat: p.nutriments.fat_serving,
          carbohydrates: p.nutriments.carbohydrates_serving,
          sugars: p.nutriments.sugars_serving,
          proteins: p.nutriments.proteins_serving,
          salt: p.nutriments.salt_serving,
        } : null,
        ingredients: {
          text: p.ingredients_text || '',
          count: p.ingredients_n || 0,
          fromPalmOil: p.ingredients_from_palm_oil_n || 0,
        },
        allergens: (p.allergens_tags || []).map((a: string) => a.replace('en:', '')),
        labels: p.labels || '',
        packaging: p.packaging || '',
        origins: p.origins || '',
        fetchedAt: new Date().toISOString()
      } 
    };
  },
});

// Serve icon if exists
app.get('/icon.png', async (c) => {
  try {
    if (existsSync('./icon.png')) {
      const icon = readFileSync('./icon.png');
      return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
    }
  } catch {}
  return c.text('Not found', 404);
});

// ERC-8004 registration file
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://food-intel-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "food-intel",
    description: "Food & nutrition intelligence - barcode lookup, product search, nutritional data. Powered by Open Food Facts. 1 free + 5 paid endpoints via x402.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🍎 food-intel running on port ${port}`);

export default { port, fetch: app.fetch };
