export type DemoBooking = {
  business: string;
  category: string;
  customer: string;
  initials: string;
  service: string;
  duration: string;
  date: string;
  time: string;
  price: string;
  deposit: string;
  agent: string;
};

export const demoBooking: DemoBooking = {
  business: "Good Company Barbers",
  category: "Independent barbershop",
  customer: "Alex Morgan",
  initials: "AM",
  service: "Signature haircut",
  duration: "45 minutes",
  date: "Thursday, November 12",
  time: "10:30 AM",
  price: "$45.00",
  deposit: "$15.00",
  agent: "Personal AI assistant",
};

export type Feature = { title: string; description: string };
export const features: Feature[] = [
  {
    title: "Works with any AI agent",
    description:
      "Claude, ChatGPT, or a personal assistant. Meet your customers wherever they’re already making plans.",
  },
  {
    title: "Verified, approved bookings",
    description:
      "A real person behind every appointment. Every booking is verified and approved by the customer.",
  },
  {
    title: "Deposits that stop no-shows",
    description:
      "A little commitment goes a long way. Optional card deposits help protect your time and your business.",
  },
];

export const steps = [
  {
    title: "Set your hours. Just once.",
    description:
      "Your services, your availability, your deposit rules. You’re always in control.",
  },
  {
    title: "Their agent does the booking.",
    description:
      "An assistant finds a time that works. Your customer reviews and approves the details.",
  },
  {
    title: "You do what you do best.",
    description:
      "A verified appointment lands on your calendar. No back-and-forth, no extra admin.",
  },
];
