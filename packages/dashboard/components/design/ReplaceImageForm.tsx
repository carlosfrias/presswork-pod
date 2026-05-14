"use client";

import { useRef, useState } from "react";
import { replaceDesignImage } from "@/lib/actions/design";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * Compact file-upload form for re-injecting a hand-edited PNG into an
 * approved design. Lives on each approved card in DesignGrid. The action
 * (`replaceDesignImage`) versions the prior image into metadata, swaps
 * image_url to the new upload, and flips status back to needs_review so
 * the operator re-approves before Listing publishes.
 *
 * No `useTransition` here — `SubmitButton` already flips its label/disabled
 * state via React 19's `useFormStatus`, and the file input is single-use
 * (operator picks one file, hits submit, the row moves out of approved
 * status anyway).
 */
interface Props {
  id: string;
}

export function ReplaceImageForm({ id }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [hasFile, setHasFile] = useState(false);

  return (
    <form
      ref={formRef}
      action={async (fd) => {
        try {
          await replaceDesignImage(fd);
          formRef.current?.reset();
          setHasFile(false);
        } catch (err) {
          // Surface the server-action error without crashing the page.
          // The action throws on validation failures (wrong MIME, oversized,
          // non-approved status) — show that message to the operator.
          alert(err instanceof Error ? err.message : String(err));
        }
      }}
      className="flex flex-col gap-1.5"
    >
      <input type="hidden" name="id" value={id} />
      <input
        type="file"
        name="image"
        accept="image/png"
        required
        onChange={(e) => setHasFile(e.target.files != null && e.target.files.length > 0)}
        className="block w-full text-[11px] text-(--text-secondary)
          file:mr-2 file:rounded-(--radius-sm) file:border-0
          file:bg-(--surface-3) file:px-2 file:py-1
          file:text-[11px] file:text-(--text-primary)
          file:cursor-pointer
          hover:file:bg-(--surface-4)"
      />
      <SubmitButton
        size="sm"
        variant="secondary"
        className="w-full"
        disabled={!hasFile}
        idleLabel="Upload edit"
        pendingLabel="Uploading…"
      />
    </form>
  );
}
