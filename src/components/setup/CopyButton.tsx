// Small copy-to-clipboard affordance reused across the wizard (address +
// endpoint). Flashes "OK" for 1.2s on success. No-ops gracefully when the
// clipboard API is unavailable (e.g. an insecure context).

import { useState } from "react";

export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_200);
      })
      .catch(() => undefined);
  };

  return (
    <button
      type="button"
      className={copied ? "copy-btn copy-btn--copied" : "copy-btn"}
      onClick={onCopy}
      aria-label={label}
      title={label}
    >
      {copied ? "OK" : "CP"}
    </button>
  );
}
