import { AxiosInstance } from "axios";
import querystring from "querystring";

interface GetShopArgs {
  shop_id: string;
}

interface GetShopSectionArgs {
  shop_id: string;
  shop_section_id: string;
}

interface CreateReadinessStateDefinitionArgs {
  shop_id: string;
  readiness_state: string;
  min_processing_time: number;
  max_processing_time: number;
}

export const tools = [
  {
    name: "getShop",
    description: "Get shop information",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: {
          type: "string",
          description: "The ID of the shop to retrieve",
        },
      },
      required: ["shop_id"],
    },
  },
  {
    name: "getMe",
    description: "Get info about the authenticated user",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "getShopSections",
    description: "Get sections for a shop",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "The ID of the shop" },
      },
      required: ["shop_id"],
    },
  },
  {
    name: "getShopShippingProfiles",
    description:
      "Get shipping profiles for a shop. Use the returned shipping_profile_id when creating a physical listing.",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "The ID of the shop" },
      },
      required: ["shop_id"],
    },
  },
  {
    name: "getShopReturnPolicies",
    description:
      "Get return policies for a shop. Use the returned return_policy_id when creating a physical listing (required in some regions).",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "The ID of the shop" },
      },
      required: ["shop_id"],
    },
  },
  {
    name: "getShopReadinessStateDefinitions",
    description:
      "Get processing profiles (readiness states) for a shop. Use the returned readiness_state_id when creating a physical listing (required by Etsy since 2025-06).",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "The ID of the shop" },
      },
      required: ["shop_id"],
    },
  },
  {
    name: "createShopReadinessStateDefinition",
    description: "Create a processing profile (readiness state) for a shop.",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "The ID of the shop" },
        readiness_state: {
          type: "string",
          enum: ["ready_to_ship", "made_to_order"],
        },
        min_processing_time: { type: "number" },
        max_processing_time: { type: "number" },
      },
      required: ["shop_id", "readiness_state", "min_processing_time", "max_processing_time"],
    },
  },
];

export const handlers: Record<string, (args: unknown, axios: AxiosInstance) => Promise<unknown>> = {
  getMe: async (_, axios) => axios.get("/application/users/me"),
  getShop: async (args, axios) => axios.get(`/application/shops/${(args as GetShopArgs).shop_id}`),
  getShopSections: async (args, axios) =>
    axios.get(`/application/shops/${(args as GetShopSectionArgs).shop_id}/sections`),
  getShopShippingProfiles: async (args, axios) =>
    axios.get(`/application/shops/${(args as GetShopArgs).shop_id}/shipping-profiles`),
  getShopReturnPolicies: async (args, axios) =>
    axios.get(`/application/shops/${(args as GetShopArgs).shop_id}/policies/return`),
  getShopReadinessStateDefinitions: async (args, axios) =>
    axios.get(`/application/shops/${(args as GetShopArgs).shop_id}/readiness-state-definitions`),
  createShopReadinessStateDefinition: async (args, axios) => {
    const { shop_id, ...rest } = args as CreateReadinessStateDefinitionArgs;
    const payload = querystring.stringify(rest as Record<string, string | number>);
    return axios.post(`/application/shops/${shop_id}/readiness-state-definitions`, payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  },
};
