import type { Metadata } from "next";
import { Suspense } from "react";
import type { ServicesResponse } from "@/lib/types/frontdesk";
import { loadSettings } from "@/components/console/load-settings";
import { errorFeedback } from "@/components/console/api";
import { SettingsShell, SaveFeedback } from "@/components/console/form-parts";
import { ServiceForm } from "@/components/console/service-form";
export const metadata: Metadata = {
  title: "Services — Front Desk",
  description: "Manage your shop’s services, prices, and deposits.",
};
async function Services() {
  let data: ServicesResponse;
  try {
    data = await loadSettings<ServicesResponse>("services");
  } catch (error) {
    return <SaveFeedback feedback={errorFeedback(error)} />;
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {data.shop.name} · All prices in USD
      </p>
      {data.services.map((service) => (
        <ServiceForm key={service.id} service={service} />
      ))}
      {!data.services.length && (
        <p className="text-sm text-muted-foreground">
          No services yet. Add your first service below.
        </p>
      )}
      <ServiceForm />
    </>
  );
}
export default function ServicesPage() {
  return (
    <SettingsShell
      title="Services"
      description="Set what agents can book. Price changes apply to new bookings."
    >
      <Suspense fallback={<p role="status">Loading services…</p>}>
        <Services />
      </Suspense>
    </SettingsShell>
  );
}
