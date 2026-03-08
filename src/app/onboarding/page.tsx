"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc-client";

// ── Zod Schema ───────────────────────────────────────────────────

const onboardingSchema = z.object({
  niche: z.string().min(2, "Tell us your content niche").max(200),
  brandVoice: z.string().max(2000).optional(),
  tonePreferences: z.string().max(1000).optional(),
  competitorUrls: z.string().optional(), // textarea, split on newlines
  platforms: z
    .array(z.enum(["YOUTUBE", "TIKTOK", "INSTAGRAM", "LINKEDIN", "X", "FACEBOOK"]))
    .min(1, "Select at least one platform"),
  postingFrequency: z.string().optional(),
  contentStyle: z.string().optional(),
  additionalNotes: z.string().max(2000).optional(),
});

type FormData = z.infer<typeof onboardingSchema>;

const STEPS = ["Niche & Brand", "Competitors", "Platforms & Style", "Review"] as const;

const PLATFORM_OPTIONS = [
  { value: "YOUTUBE", label: "YouTube" },
  { value: "TIKTOK", label: "TikTok" },
  { value: "INSTAGRAM", label: "Instagram" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "X", label: "X (Twitter)" },
  { value: "FACEBOOK", label: "Facebook" },
] as const;

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const router = useRouter();

  const { data: existing } = api.onboarding.get.useQuery();
  const submit = api.onboarding.submit.useMutation({
    onSuccess: () => router.push("/provisioning"),
  });

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    trigger,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: {
      niche: existing?.niche ?? "",
      brandVoice: existing?.brandVoice ?? "",
      tonePreferences: existing?.tonePreferences ?? "",
      competitorUrls:
        (existing?.competitorUrls as string[] | undefined)?.join("\n") ?? "",
      platforms: (existing?.platforms as string[] | undefined) as FormData["platforms"] ?? [],
      postingFrequency: existing?.postingFrequency ?? "",
      contentStyle: existing?.contentStyle ?? "",
      additionalNotes: existing?.additionalNotes ?? "",
    },
  });

  const selectedPlatforms = watch("platforms") ?? [];

  async function nextStep() {
    // Validate current step fields before advancing
    const fieldsPerStep: (keyof FormData)[][] = [
      ["niche", "brandVoice", "tonePreferences"],
      ["competitorUrls"],
      ["platforms", "postingFrequency", "contentStyle"],
      [],
    ];
    const valid = await trigger(fieldsPerStep[step]);
    if (valid) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function prevStep() {
    setStep((s) => Math.max(s - 1, 0));
  }

  function togglePlatform(platform: FormData["platforms"][number]) {
    const current = selectedPlatforms;
    const next = current.includes(platform)
      ? current.filter((p) => p !== platform)
      : [...current, platform];
    setValue("platforms", next, { shouldValidate: true });
  }

  function onSubmit(data: FormData) {
    const competitorUrls = (data.competitorUrls ?? "")
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    submit.mutate({
      niche: data.niche,
      brandVoice: data.brandVoice,
      tonePreferences: data.tonePreferences,
      competitorUrls,
      platforms: data.platforms,
      postingFrequency: data.postingFrequency,
      contentStyle: data.contentStyle,
      additionalNotes: data.additionalNotes,
    });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white p-8 shadow-lg">
        {/* Progress bar */}
        <div className="mb-8">
          <div className="mb-2 flex justify-between text-sm text-gray-500">
            {STEPS.map((label, i) => (
              <span
                key={label}
                className={i <= step ? "font-medium text-gray-900" : ""}
              >
                {label}
              </span>
            ))}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-300"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)}>
          {/* Step 1: Niche & Brand */}
          {step === 0 && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-gray-900">
                Tell us about your brand
              </h2>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Content Niche *
                </label>
                <input
                  {...register("niche")}
                  placeholder="e.g., Tech reviews, Fitness coaching, Real estate..."
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                {errors.niche && (
                  <p className="mt-1 text-sm text-red-600">{errors.niche.message}</p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Brand Voice
                </label>
                <textarea
                  {...register("brandVoice")}
                  rows={3}
                  placeholder="Describe how your brand sounds — professional, casual, humorous, authoritative..."
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Tone Preferences
                </label>
                <input
                  {...register("tonePreferences")}
                  placeholder="e.g., Friendly but expert, No slang, Always data-driven..."
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          {/* Step 2: Competitors */}
          {step === 1 && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-gray-900">
                Who are your competitors?
              </h2>
              <p className="text-sm text-gray-500">
                Paste profile URLs of creators you want to track. One per line.
                We'll monitor their content for outlier detection.
              </p>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Competitor Profile URLs
                </label>
                <textarea
                  {...register("competitorUrls")}
                  rows={6}
                  placeholder={
                    "https://youtube.com/@competitor1\nhttps://tiktok.com/@competitor2\nhttps://instagram.com/competitor3"
                  }
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 font-mono text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          {/* Step 3: Platforms & Style */}
          {step === 2 && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-gray-900">
                Platforms & content style
              </h2>

              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  Target Platforms *
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {PLATFORM_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => togglePlatform(opt.value)}
                      className={`rounded-lg border-2 px-4 py-2.5 text-sm font-medium transition ${
                        selectedPlatforms.includes(opt.value)
                          ? "border-blue-600 bg-blue-50 text-blue-700"
                          : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {errors.platforms && (
                  <p className="mt-1 text-sm text-red-600">{errors.platforms.message}</p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Posting Frequency
                </label>
                <select
                  {...register("postingFrequency")}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Select frequency...</option>
                  <option value="daily">Daily</option>
                  <option value="3x/week">3x per week</option>
                  <option value="weekly">Weekly</option>
                  <option value="custom">Custom (tell us in notes)</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Content Style
                </label>
                <select
                  {...register("contentStyle")}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Select style...</option>
                  <option value="educational">Educational / How-to</option>
                  <option value="entertainment">Entertainment / Viral</option>
                  <option value="thought-leadership">Thought Leadership</option>
                  <option value="product-showcase">Product Showcase</option>
                  <option value="mixed">Mixed</option>
                </select>
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {step === 3 && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-gray-900">Review & submit</h2>
              <p className="text-sm text-gray-500">
                After submitting, our team will configure your AI agents, proxy
                fleet, and content pipeline. This typically takes 24-48 hours.
              </p>

              <div className="space-y-3 rounded-lg bg-gray-50 p-4 text-sm">
                <Row label="Niche" value={watch("niche")} />
                <Row label="Brand Voice" value={watch("brandVoice") || "—"} />
                <Row label="Tone" value={watch("tonePreferences") || "—"} />
                <Row
                  label="Competitors"
                  value={
                    (watch("competitorUrls") ?? "")
                      .split("\n")
                      .filter(Boolean).length + " URLs"
                  }
                />
                <Row
                  label="Platforms"
                  value={selectedPlatforms.join(", ") || "—"}
                />
                <Row label="Frequency" value={watch("postingFrequency") || "—"} />
                <Row label="Style" value={watch("contentStyle") || "—"} />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Additional Notes
                </label>
                <textarea
                  {...register("additionalNotes")}
                  rows={3}
                  placeholder="Anything else we should know about your content strategy..."
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {submit.error && (
                <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                  {submit.error.message}
                </div>
              )}
            </div>
          )}

          {/* Navigation */}
          <div className="mt-8 flex justify-between">
            <button
              type="button"
              onClick={prevStep}
              disabled={step === 0}
              className="rounded-lg px-6 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:invisible"
            >
              Back
            </button>

            {step < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={nextStep}
                className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Continue
              </button>
            ) : (
              <button
                type="submit"
                disabled={submit.isPending}
                className="rounded-lg bg-green-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {submit.isPending ? "Submitting..." : "Submit & Start Setup"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="font-medium text-gray-600">{label}</span>
      <span className="text-gray-900">{value}</span>
    </div>
  );
}
