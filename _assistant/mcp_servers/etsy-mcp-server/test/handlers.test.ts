import { describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { handlers as listingHandlers } from '../src/handlers/listing.js';
import { handlers as shopHandlers } from '../src/handlers/shop.js';

function fakeAxios() {
  return {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
  } as unknown as AxiosInstance;
}

describe('listing handlers', () => {
  it('createDraftListing sends form-encoded body with legacy=false', async () => {
    const axios = fakeAxios();
    await listingHandlers.createDraftListing(
      {
        shop_id: '123',
        title: 'Vase',
        description: 'A vase',
        price: 25,
        quantity: 1,
        who_made: 'i_did',
        when_made: 'made_to_order',
        taxonomy_id: 1633,
      },
      axios
    );
    const [url, payload, config] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('/application/shops/123/listings?legacy=false');
    expect(payload).toContain('title=Vase');
    expect(payload).not.toContain('shop_id=');
    expect(config?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('createDraftListing joins tags and materials into comma-separated strings', async () => {
    const axios = fakeAxios();
    await listingHandlers.createDraftListing(
      {
        shop_id: '123',
        title: 'Vase',
        description: 'A vase',
        price: 25,
        quantity: 1,
        who_made: 'i_did',
        when_made: 'made_to_order',
        taxonomy_id: 1633,
        tags: ['3d printed', 'vase', 'decor'],
        materials: ['PLA', 'plastic'],
      },
      axios
    );
    const [, payload] = vi.mocked(axios.post).mock.calls[0];
    expect(payload).toContain(`tags=${encodeURIComponent('3d printed,vase,decor')}`);
    expect(payload).toContain(`materials=${encodeURIComponent('PLA,plastic')}`);
    // must not be encoded as repeated keys
    expect((payload as string).match(/tags=/g)).toHaveLength(1);
  });

  it('updateListing joins array fields and targets the listing URL', async () => {
    const axios = fakeAxios();
    await listingHandlers.updateListing(
      { shop_id: '123', listing_id: '456', title: 'New', tags: ['a', 'b'] },
      axios
    );
    const [url, payload] = vi.mocked(axios.put).mock.calls[0];
    expect(url).toBe('/application/shops/123/listings/456');
    expect(payload).toContain(`tags=${encodeURIComponent('a,b')}`);
  });

  it('uploadListingImage rejects a missing file with McpError', async () => {
    const axios = fakeAxios();
    await expect(
      listingHandlers.uploadListingImage(
        { shop_id: '123', listing_id: '456', image_path: '/nonexistent/img.jpg' },
        axios
      )
    ).rejects.toBeInstanceOf(McpError);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('shop handlers', () => {
  it.each([
    ['getShopShippingProfiles', '/application/shops/123/shipping-profiles'],
    ['getShopReturnPolicies', '/application/shops/123/policies/return'],
    ['getShopReadinessStateDefinitions', '/application/shops/123/readiness-state-definitions'],
  ])('%s hits %s', async (name, expectedUrl) => {
    const axios = fakeAxios();
    await shopHandlers[name]({ shop_id: '123' }, axios);
    expect(axios.get).toHaveBeenCalledWith(expectedUrl);
  });

  it('createShopReadinessStateDefinition posts form-encoded body without shop_id', async () => {
    const axios = fakeAxios();
    await shopHandlers.createShopReadinessStateDefinition(
      {
        shop_id: '123',
        readiness_state: 'ready_to_ship',
        min_processing_time: 1,
        max_processing_time: 3,
      },
      axios
    );
    const [url, payload, config] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('/application/shops/123/readiness-state-definitions');
    expect(payload).toContain('readiness_state=ready_to_ship');
    expect(payload).not.toContain('shop_id=');
    expect(config?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
});
