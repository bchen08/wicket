"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errorFeedback, type Feedback } from "@/components/console/api";
export function useSave() {
  const router = useRouter();
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  async function save(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setFeedback(null);
    try {
      await action();
      setFeedback({ message: "Saved", saved: true });
      router.refresh();
    } catch (error) {
      setFeedback(errorFeedback(error));
    } finally {
      running.current = false;
      setPending(false);
    }
  }
  return { pending, feedback, save, clear: () => setFeedback(null) };
}
