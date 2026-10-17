"use client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n/provider";

/** Printable crate label: QR code to the public record, with the code written out for manual entry. */
export function HarvestLabel({ code, crop, harvestedOn, quantity, farm }: { code: string; crop: string; harvestedOn: string; quantity: string; farm: string }) {
  const { m, fmt } = useI18n();
  const t = m.harvests;
  const [src, setSrc] = useState<string>();
  const [url, setUrl] = useState("");

  useEffect(() => {
    const u = `${window.location.origin}/verify/${code}`;
    setUrl(u);
    // Error correction "M" survives smudges on a crate; the margin is the quiet zone scanners need.
    QRCode.toDataURL(u, { errorCorrectionLevel: "M", margin: 2, width: 480, color: { dark: "#000000", light: "#ffffff" } })
      .then(setSrc)
      .catch(() => setSrc(undefined));
  }, [code]);

  function print() {
    document.body.dataset.print = "label";
    const done = () => {
      delete document.body.dataset.print;
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  }

  return (
    <div className="harvest-label-wrap">
      <figure className="harvest-label">
        {src ? <img src={src} alt={t.qrAlt(code)} width={160} height={160} /> : <div className="harvest-label__qr-placeholder" aria-hidden="true" />}
        <figcaption>
          <strong className="harvest-label__code ltr">{code}</strong>
          <span>{crop}</span>
          <span>
            {fmt.day(harvestedOn)} · {quantity}
          </span>
          <span>{farm}</span>
          <span className="harvest-label__scan">{t.scan}</span>
          <span className="harvest-label__url ltr">{url.replace(/^https?:\/\//, "")}</span>
        </figcaption>
      </figure>
      <button type="button" className="mf-button" onClick={print}>
        {t.print}
      </button>
    </div>
  );
}
