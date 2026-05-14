"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";

/**
 * Form-submit button that flips into a pending state the instant its parent
 * <form> is submitted. Built on React 19's useFormStatus — must be rendered
 * INSIDE the <form> element so the hook can read that form's status.
 *
 * Eliminates the "I clicked the button and nothing happened for two seconds"
 * gap on server actions: as soon as the action starts, the button disables
 * and swaps to `pendingLabel`. Works with both server actions and client
 * action handlers passed via the form's `action` prop.
 */
interface SubmitButtonProps extends Omit<ButtonProps, "type"> {
  idleLabel: React.ReactNode;
  pendingLabel?: React.ReactNode;
}

export function SubmitButton({
  idleLabel,
  pendingLabel,
  disabled,
  ...rest
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button {...rest} type="submit" disabled={disabled || pending}>
      {pending ? (pendingLabel ?? idleLabel) : idleLabel}
    </Button>
  );
}
