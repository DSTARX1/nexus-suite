"use client";

import { useEffect, useState } from "react";

const STEPS = [
  { label: "Payment received", done: true },
  { label: "Onboarding form submitted", done: true },
  { label: "Configuring AI agents for your niche", done: false },
  { label: "Provisioning proxy fleet", done: false },
  { label: "Setting up content pipeline", done: false },
  { label: "Final review by our team", done: false },
];

export default function ProvisioningPage() {
  const [dots, setDots] = useState("");

  // Animated dots for the "in progress" step
  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "" : d + "."));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Find first incomplete step
  const activeIndex = STEPS.findIndex((s) => !s.done);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800 p-4">
      <div className="w-full max-w-lg text-center">
        {/* Animated logo placeholder */}
        <div className="mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-2xl bg-blue-600 shadow-lg shadow-blue-600/30">
          <span className="text-3xl font-bold text-white">N</span>
        </div>

        <h1 className="mb-2 text-3xl font-bold text-white">
          Setting up your Nexus
        </h1>
        <p className="mb-10 text-gray-400">
          Our team is configuring your AI agents and content pipeline.
          <br />
          This typically takes 24-48 hours. We'll email you when it's ready.
        </p>

        {/* Progress steps */}
        <div className="mx-auto max-w-sm text-left">
          {STEPS.map((step, i) => (
            <div key={step.label} className="flex items-start gap-3 pb-6 last:pb-0">
              {/* Connector line + icon */}
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm ${
                    step.done
                      ? "bg-green-500 text-white"
                      : i === activeIndex
                        ? "bg-blue-500 text-white animate-pulse"
                        : "bg-gray-700 text-gray-500"
                  }`}
                >
                  {step.done ? "\u2713" : i === activeIndex ? "\u2022" : ""}
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className={`mt-1 h-6 w-0.5 ${
                      step.done ? "bg-green-500/50" : "bg-gray-700"
                    }`}
                  />
                )}
              </div>

              {/* Label */}
              <span
                className={`pt-0.5 text-sm ${
                  step.done
                    ? "text-green-400"
                    : i === activeIndex
                      ? "text-white font-medium"
                      : "text-gray-600"
                }`}
              >
                {step.label}
                {i === activeIndex && dots}
              </span>
            </div>
          ))}
        </div>

        {/* Support link */}
        <p className="mt-12 text-sm text-gray-500">
          Questions?{" "}
          <a href="mailto:support@nexus.ai" className="text-blue-400 hover:underline">
            Contact our team
          </a>
        </p>
      </div>
    </div>
  );
}
