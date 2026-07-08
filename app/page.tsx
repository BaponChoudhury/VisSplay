"use client";

import dynamic from "next/dynamic";

// Map + localStorage are browser-only; skip SSR entirely.
const SplayCheckApp = dynamic(() => import("@/components/SplayCheckApp"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center text-slate-500">
      Loading SplayCheck…
    </div>
  ),
});

export default function Page() {
  return <SplayCheckApp />;
}
