// Everything on the landing page is Hart's Barbers as it is configured today: keep it in step with the real shop.

export const contactHref = "mailto:bryanchen2026@gmail.com?subject=Front%20Desk";

export const shop = {
  name: "Hart's Barbers",
  path: "/harts",
};

export type MenuItem = { name: string; duration: string; price: string; deposit: string };

export const menu: MenuItem[] = [
  { name: "Haircut", duration: "30 min", price: "$35", deposit: "$10 deposit" },
  { name: "Beard trim", duration: "15 min", price: "$15", deposit: "no deposit" },
];

export type SlipLine = { label: string; value: string };

export const slip: { lines: SlipLine[]; footer: SlipLine[] } = {
  lines: [
    { label: "Service", value: "Haircut, 30 min" },
    { label: "When", value: "Sat 2:30 pm" },
    { label: "Price", value: "$35.00" },
    { label: "Deposit", value: "$10.00 held" },
  ],
  footer: [
    { label: "Booked by", value: "Claude" },
    { label: "Approved by", value: "the customer" },
  ],
};

export const approvalText =
  "Claude asked Hart's Barbers to book Haircut on Sat 14 Nov, 2:30 pm EST for you. Approve or decline:";

export const shopAlert = "New booking: Haircut, Sat 14 Nov 2:30 pm";

export const agentEndpoints = [
  { label: "MCP endpoint", path: "/api/mcp" },
  { label: "Shop guide", path: "/api/shops/harts/agents.md" },
  { label: "Discovery", path: "/.well-known/poppy.json" },
];

export const bookCall = `tools/call book  →  POST /api/mcp
{
  "service_id": "haircut",
  "start": "2026-11-14T14:30:00-05:00",
  "customer_phone": "+14015550123"
}`;
