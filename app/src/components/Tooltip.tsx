import { autoUpdate, flip, offset, shift, size, useFloating, type Placement } from "@floating-ui/react-dom";
import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** Tooltip body. */
  content: ReactNode;
  /** The element the tooltip is anchored to. */
  children: ReactNode;
  className?: string;
  placement?: Placement;
  /** Accessible name of the trigger (the tooltip text is exposed through aria-describedby). */
  label?: string;
  width?: number;
}

/**
 * Hover/focus tooltip rendered in a portal on <body> and positioned next to its trigger with floating-ui
 * (offset + flip + shift). The portal matters: ancestors with a CSS transform (the lifting cards) turn
 * `position: fixed` into "relative to the card", which made tooltips jump and land in a corner.
 */
export function Tooltip({ content, children, className = "", placement = "bottom-start", label, width = 290 }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { refs, floatingStyles } = useFloating({
    open,
    placement,
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(120, availableHeight)}px`;
        },
      }),
    ],
  });

  return (
    <>
      <span
        ref={refs.setReference}
        className={className}
        tabIndex={0}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div ref={refs.setFloating} id={id} role="tooltip" className="float-tip" style={{ ...floatingStyles, width }}>
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
