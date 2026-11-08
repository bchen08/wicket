import Link from "next/link";
import { useId, type ComponentProps } from "react";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Feedback } from "@/components/console/api";
export function SaveFeedback({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  return (
    <div
      role={feedback.saved ? "status" : "alert"}
      className="flex flex-col gap-1 border-y border-border py-3 text-sm leading-relaxed wrap-anywhere"
    >
      <p>{feedback.message}</p>
      {feedback.nextAction && (
        <p className="text-muted-foreground">{feedback.nextAction}</p>
      )}
      {feedback.unauthorized && (
        <Link
          className="w-fit underline underline-offset-4"
          href="/console/unlock"
        >
          Unlock the console
        </Link>
      )}
    </div>
  );
}
export function FormInput({
  label,
  hint,
  ...props
}: ComponentProps<typeof Input> & { label: string; hint?: string }) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        {...props}
        id={id}
        className="min-h-11"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
    </Field>
  );
}
export function SettingsShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-12 sm:px-10 sm:py-16">
      <header className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Your shop, your rules
        </p>
        <h1 className="font-serif text-4xl leading-tight text-balance sm:text-5xl">{title}</h1>
        <p className="max-w-lg text-base leading-relaxed text-muted-foreground text-pretty">
          {description}
        </p>
      </header>
      {children}
    </main>
  );
}
