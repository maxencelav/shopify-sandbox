import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorageInstance } from "../shopify.server.ts";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session } = await authenticate.webhook(request);
  // The shop uninstalled the app: its sessions are worthless now.
  if (session) await sessionStorageInstance.deleteSessions([session.id]);
  console.info(`app uninstalled from ${shop}`);
  return new Response(null, { status: 200 });
};
