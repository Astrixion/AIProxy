// Optional host-owned coordination; standalone engine users do not enable it.
export function deploymentRuntime() {
  return globalThis[Symbol.for("aiproxy.deployment")];
}

export function beginDeploymentWork(label) {
  return deploymentRuntime()?.begin(label) ?? (() => {});
}

export function trackDeploymentWork(label, fn) {
  return deploymentRuntime()?.track(label, fn) ?? Promise.resolve().then(fn);
}

export function refreshDeploymentCredentials(provider, credentials, refresh) {
  const runtime = deploymentRuntime();
  if (!runtime) return refresh(credentials);
  if (!runtime.refreshCredentials) throw new Error("Managed credential coordination is not ready");
  return runtime.refreshCredentials(provider, credentials, refresh);
}
