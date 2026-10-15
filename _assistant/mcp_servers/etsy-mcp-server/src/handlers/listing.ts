import { AxiosInstance } from "axios";
import querystring from "querystring";
import fs from "fs";
import FormData from "form-data";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export const tools = [
  {
    name: "getListingsByShop",
    description: "Get listings for a given shop",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "The ID of the shop" },
        state: {
          type: "string",
          description: "The state of the listings to retrieve",
          enum: ["active", "inactive", "sold_out", "draft", "expired"],
        },
      },
      required: ["shop_id"],
    },
  },
  {
    name: "createDraftListing",
    description: "Create a new draft listing",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "The ID of the shop" },
        title: { type: "string", description: "The title of the listing" },
        description: {
          type: "string",
          description: "The description of the listing",
        },
        price: { type: "number", description: "The price of the listing" },
        quantity: {
          type: "number",
          description: "The quantity of the listing",
        },
        who_made: {
          type: "string",
          enum: ["i_did", "someone_else", "collective"],
        },
        when_made: {
          type: "string",
          enum: [
            "made_to_order",
            "2020_2025",
            "2010_2019",
            "2006_2009",
            "before_2006",
            "2000_2005",
            "1990s",
            "1980s",
            "1970s",
            "1960s",
            "1950s",
            "1940s",
            "1930s",
            "1920s",
            "1910s",
            "1900s",
            "1800s",
            "1700s",
            "before_1700",
          ],
        },
        taxonomy_id: {
          type: "number",
          description: "The taxonomy ID of the listing",
        },
        shipping_profile_id: {
          type: "number",
          description:
            "Shipping profile ID. REQUIRED for physical listings. Get it from getShopShippingProfiles.",
        },
        return_policy_id: {
          type: "number",
          description:
            "Return policy ID. Required for physical listings in some regions (e.g. EU). Get it from getShopReturnPolicies.",
        },
        readiness_state_id: {
          type: "number",
          description:
            "Processing profile ID. REQUIRED for physical listings (Etsy API change, 2025-06). Get it from getShopReadinessStateDefinitions.",
        },
        shop_section_id: {
          type: "number",
          description:
            "Optional shop section to place the listing in. Get it from getShopSections.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Up to 13 SEO tags, each 20 chars or fewer.",
        },
        materials: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of materials.",
        },
        type: {
          type: "string",
          enum: ["physical", "download"],
          description: "Listing type. Defaults to physical. New listings are created as drafts.",
        },
      },
      required: [
        "shop_id",
        "title",
        "description",
        "price",
        "quantity",
        "who_made",
        "when_made",
        "taxonomy_id",
      ],
    },
  },
  {
    name: "uploadListingImage",
    description: "Upload an image for a listing",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "The ID of the shop" },
        listing_id: { type: "string", description: "The ID of the listing" },
        image_path: {
          type: "string",
          description: "Filesystem path to the image file to upload. The file must exist.",
        },
      },
      required: ["shop_id", "listing_id", "image_path"],
    },
  },
  {
    name: "updateListing",
    description: "Update an existing listing",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "The ID of the shop" },
        listing_id: { type: "string", description: "The ID of the listing" },
        title: { type: "string", description: "The new title of the listing" },
        description: {
          type: "string",
          description: "The new description of the listing",
        },
        price: { type: "number", description: "The new price of the listing" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Up to 13 SEO tags (replaces existing tags).",
        },
        materials: {
          type: "array",
          items: { type: "string" },
          description: "List of materials (replaces existing).",
        },
        shipping_profile_id: {
          type: "number",
          description: "Shipping profile ID.",
        },
        shop_section_id: { type: "number", description: "Shop section ID." },
      },
      required: ["shop_id", "listing_id"],
    },
  },
  {
    name: "getListingImages",
    description: "Get images for a listing",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: { type: "string", description: "The ID of the listing" },
      },
      required: ["listing_id"],
    },
  },
  {
    name: "getListingFiles",
    description: "Get files for a digital listing",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: { type: "string", description: "The ID of the listing" },
      },
      required: ["listing_id"],
    },
  },
  {
    name: "getListingInventory",
    description: "Get inventory details for a listing",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: { type: "string", description: "The ID of the listing" },
      },
      required: ["listing_id"],
    },
  },
  {
    name: "updateListingInventory",
    description: "Update inventory for a listing",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: { type: "string", description: "The ID of the listing" },
        products: { type: "array", description: "Inventory products" },
      },
      required: ["listing_id", "products"],
    },
  },
];

interface GetListingsByShopArgs {
  shop_id: string;
  state?: string;
}

interface CreateDraftListingArgs {
  shop_id: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  who_made: string;
  when_made: string;
  taxonomy_id: number;
  [key: string]: unknown;
}

interface UploadListingImageArgs {
  shop_id: string;
  listing_id: string;
  image_path: string;
}

interface UpdateListingArgs {
  shop_id: string;
  listing_id: string;
  title?: string;
  description?: string;
  price?: number;
  [key: string]: unknown;
}

interface GetListingImagesArgs {
  listing_id: string;
}

interface GetListingFilesArgs {
  listing_id: string;
}

interface GetListingInventoryArgs {
  listing_id: string;
}

interface UpdateListingInventoryArgs {
  listing_id: string;
  products: unknown[];
}

// Etsy's form-encoded API expects array fields (tags, materials) as a single
// comma-separated string, not repeated keys. Normalize before stringify.
function encodeEtsyArrays(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of ["tags", "materials"]) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).join(",");
    }
  }
  return out;
}

export const handlers: Record<string, (args: unknown, axios: AxiosInstance) => Promise<unknown>> = {
  getListingsByShop: async (args, axios) =>
    axios.get(`/application/shops/${(args as GetListingsByShopArgs).shop_id}/listings`, {
      params: { state: (args as GetListingsByShopArgs).state },
    }),

  createDraftListing: async (args, axios) => {
    const { shop_id, ...rest } = args as CreateDraftListingArgs;
    const body = encodeEtsyArrays(rest);
    const payload = querystring.stringify(body as Record<string, string | number | boolean>);
    // Etsy requires this flag during the readiness_state_id migration window.
    return axios.post(`/application/shops/${shop_id}/listings?legacy=false`, payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  },

  uploadListingImage: async (args, axios) => {
    const { shop_id, listing_id, image_path } = args as UploadListingImageArgs;
    if (!fs.existsSync(image_path)) {
      throw new McpError(ErrorCode.InvalidRequest, `File not found: ${image_path}`);
    }
    const form = new FormData();
    form.append("image", fs.createReadStream(image_path));
    return axios.post(`/application/shops/${shop_id}/listings/${listing_id}/images`, form, {
      headers: form.getHeaders(),
    });
  },

  updateListing: async (args, axios) => {
    const { shop_id, listing_id, ...rest } = args as UpdateListingArgs;
    const body = encodeEtsyArrays(rest);
    const payload = querystring.stringify(body as Record<string, string | number | boolean>);
    return axios.put(`/application/shops/${shop_id}/listings/${listing_id}`, payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  },

  getListingImages: async (args, axios) =>
    axios.get(`/application/listings/${(args as GetListingImagesArgs).listing_id}/images`),

  getListingFiles: async (args, axios) =>
    axios.get(`/application/listings/${(args as GetListingFilesArgs).listing_id}/files`),

  getListingInventory: async (args, axios) =>
    axios.get(`/application/listings/${(args as GetListingInventoryArgs).listing_id}/inventory`),

  updateListingInventory: async (args, axios) => {
    const { listing_id, products } = args as UpdateListingInventoryArgs;
    return axios.put(`/application/listings/${listing_id}/inventory`, {
      products,
    });
  },
};
