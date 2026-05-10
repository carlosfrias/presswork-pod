import Bottleneck from "bottleneck";
import retry from "async-retry";
import { z } from "zod";
import { getSettings } from "@presswork/shared";

export class PrintifyOrderError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "PrintifyOrderError";
  }
}

interface LineItem {
  blueprintId: number;
  variantId: number;
  imageUrl: string;
  quantity: number;
}

interface Address {
  firstName: string;
  lastName: string;
  email: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  country: string;
  zip: string;
}

export interface CreateOrderInput {
  etsyReceiptId: string;
  lineItems: LineItem[];
  address: Address;
}

const PrintifyOrderResponseSchema = z.object({
  id: z.string(),
});

const _PrintifyTrackingSchema = z.object({
  number: z.string(),
  url: z.string().optional(),
  carrier: z.string().optional(),
});

const PrintifyOrderDetailSchema = z.object({
  id: z.string(),
  status: z.string(),
  shipments: z
    .array(
      z.object({
        carrier: z.string().optional(),
        number: z.string().optional(),
        url: z.string().optional(),
        delivered_at: z.string().nullable().optional(),
        shipped_at: z.string().nullable().optional(),
      })
    )
    .optional()
    .default([]),
});

export type PrintifyOrderDetail = {
  status: string;
  tracking?: { number: string; url: string; carrier: string };
};

// Conservative Printify rate limit: 5 req/sec
const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 200 });

async function printifyFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const { PRINTIFY_API_TOKEN } = getSettings();
  return limiter.schedule(() =>
    retry(
      async (bail) => {
        const res = await fetch(`https://api.printify.com/v1${path}`, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${PRINTIFY_API_TOKEN}`,
            ...(init.headers as Record<string, string> | undefined),
          },
        });
        if (!res.ok) {
          const body = await res.text();
          if (res.status < 500) {
            bail(new PrintifyOrderError(`Printify ${res.status}: ${body}`, res.status));
            return;
          }
          throw new PrintifyOrderError(`Printify ${res.status}: ${body}`, res.status);
        }
        return res.json();
      },
      { retries: 3, factor: 2, minTimeout: 500 }
    )
  );
}

export async function createOrder(
  input: CreateOrderInput
): Promise<{ printifyOrderId: string }> {
  const { PRINTIFY_SHOP_ID } = getSettings();

  const body = {
    label: `etsy-${input.etsyReceiptId}`,
    line_items: input.lineItems.map((item) => ({
      blueprint_id: item.blueprintId,
      variant_id: item.variantId,
      print_areas: { front: { src: item.imageUrl } },
      quantity: item.quantity,
    })),
    shipping_method: 1,
    address_to: {
      first_name: input.address.firstName,
      last_name: input.address.lastName,
      email: input.address.email,
      address1: input.address.address1,
      address2: input.address.address2,
      city: input.address.city,
      state: input.address.state,
      country: input.address.country,
      zip: input.address.zip,
    },
  };

  const data = await printifyFetch(
    `/shops/${PRINTIFY_SHOP_ID}/orders.json`,
    { method: "POST", body: JSON.stringify(body) }
  );

  const parsed = PrintifyOrderResponseSchema.parse(data);
  return { printifyOrderId: parsed.id };
}

export async function getOrder(printifyOrderId: string): Promise<PrintifyOrderDetail> {
  const { PRINTIFY_SHOP_ID } = getSettings();
  const data = await printifyFetch(`/shops/${PRINTIFY_SHOP_ID}/orders/${printifyOrderId}.json`);
  const parsed = PrintifyOrderDetailSchema.parse(data);

  const shipment = parsed.shipments?.[0];
  if (
    (parsed.status === "fulfilled" || parsed.status === "shipped") &&
    shipment?.number
  ) {
    return {
      status: parsed.status,
      tracking: {
        number: shipment.number,
        url: shipment.url ?? "",
        carrier: shipment.carrier ?? "",
      },
    };
  }

  return { status: parsed.status };
}
