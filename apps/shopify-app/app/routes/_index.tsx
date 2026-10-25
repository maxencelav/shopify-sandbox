import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return null;
};

export default function Index() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 32, maxWidth: 560 }}>
      <h1>Shopify → ERP order sync</h1>
      <p>
        Install the app on a development store to see the sync screen.
      </p>
    </main>
  );
}
