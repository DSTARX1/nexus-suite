export default function SuspendedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">
          Account Suspended
        </h1>
        <p className="text-gray-600 mb-6">
          Your account has been suspended. If you believe this is an error,
          please contact our support team.
        </p>
        <a
          href="mailto:support@nexus-suite.com"
          className="inline-block rounded-lg bg-gray-900 px-6 py-3 text-sm font-medium text-white hover:bg-gray-800"
        >
          Contact Support
        </a>
      </div>
    </div>
  );
}
