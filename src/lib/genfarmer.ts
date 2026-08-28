import "server-only";

import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";

export type GenFarmerDevice = {
  serialNo: string;
  currentDeviceId: string;
  name?: string;
  index?: number;
  connectionType?: string;
  width?: number;
  height?: number;
};

export type GenFarmerApp = {
  id: string;
  name: string;
  version: string;
  input?: unknown[];
  script?: { variables?: TaskVariable[] };
};

export type TaskVariable = {
  id: string;
  name: string;
  label?: string;
  value: unknown;
  secret?: boolean;
};

export type GenFarmerTask = {
  id: string;
  userId: number;
  appId: string;
  name: string;
  input: unknown[];
  variables: TaskVariable[];
  enableInput: boolean;
  config: Record<string, unknown>;
  devices: {
    enable: boolean;
    list: Array<{ id: string; serialNo: string; name?: string }>;
  };
};

export type GenFarmerRun = {
  id: string;
  appId: string;
  taskId: string;
  status: number;
  createdAt: string;
  finishedAt?: string | null;
  deviceStatuses?: Array<{
    deviceId: string;
    status: number;
    finishedAt?: string | null;
  }>;
};

export type GenFarmerRunStorage = {
  data: unknown;
};

type ApiEnvelope<T> = { success: boolean; data: T; message?: string };
type ListEnvelope<T> = {
  items: T[];
  pagination: { total_items: number };
};

async function request<T>(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${appConfig.genFarmerUrl}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AppError(
      "GenFarmer no está disponible en el puerto configurado.",
      503,
      "GENFARMER_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
    );
  }

  const text = await response.text();
  let payload: ApiEnvelope<T> | undefined;
  try {
    payload = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    payload = undefined;
  }

  if (!response.ok || payload?.success === false) {
    throw new AppError(
      payload?.message || `GenFarmer respondió HTTP ${response.status}.`,
      response.status >= 400 ? response.status : 502,
      "GENFARMER_ERROR",
    );
  }
  if (!payload) {
    throw new AppError("Respuesta inválida de GenFarmer.", 502, "INVALID_RESPONSE");
  }
  return payload.data;
}

export async function getGenFarmerHealth() {
  try {
    const response = await fetch(`${appConfig.genFarmerUrl}/`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: response.ok, version: (await response.text()).trim() };
  } catch {
    return { ok: false, version: null };
  }
}

export async function assertGenFarmerAuthenticated() {
  const payload = await request<{
    id?: number;
    is_valid?: boolean;
    plan?: { id?: number; name?: string; plan_expired_at?: string };
    data?: {
      id?: number;
      is_valid?: boolean;
      plan?: { id?: number; name?: string; plan_expired_at?: string };
    };
  }>("/backend/auth/me").catch((error: unknown) => {
    if (
      error instanceof AppError &&
      (error.status === 401 || /unauthorized|token invalid|re-login/i.test(error.message))
    ) {
      throw new AppError(
        "GenFarmer no tiene una sesión válida. Vuelve a iniciar sesión en GenFarmer.",
        409,
        "GENFARMER_AUTH_REQUIRED",
      );
    }
    throw error;
  });

  const user = payload.data ?? payload;
  if (user.id !== appConfig.genFarmerUserId) {
    throw new AppError(
      `GenFarmer inició sesión con el usuario ${user.id ?? "desconocido"}, pero el panel usa ${appConfig.genFarmerUserId}.`,
      409,
      "GENFARMER_USER_MISMATCH",
    );
  }

  const planExpiresAt = user.plan?.plan_expired_at;
  if (planExpiresAt && Date.parse(planExpiresAt) <= Date.now()) {
    throw new AppError(
      "El plan de GenFarmer está vencido.",
      409,
      "GENFARMER_PLAN_EXPIRED",
      { planExpiresAt },
    );
  }
  if (user.is_valid === false) {
    throw new AppError(
      "El plan de GenFarmer está vigente, pero no autoriza automatizaciones en este equipo.",
      409,
      "GENFARMER_DEVICE_NOT_AUTHORIZED",
      {
        planId: user.plan?.id,
        planName: user.plan?.name,
        planExpiresAt,
      },
    );
  }

  try {
    await request<unknown>("/backend/auth/client-ip");
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.status === 401 || /unauthorized|token invalid|re-login/i.test(error.message))
    ) {
      throw new AppError(
        "GenFarmer rechazó la validación de la sesión. Vuelve a iniciar sesión en GenFarmer.",
        409,
        "GENFARMER_AUTH_REQUIRED",
      );
    }
    throw error;
  }
}

export function getDevices() {
  return request<GenFarmerDevice[]>("/automation/devices");
}

export function getApps() {
  const query = new URLSearchParams({
    userId: String(appConfig.genFarmerUserId),
    name: "",
    limit: "100",
    page: "1",
    order: "desc",
    orderBy: "updatedAt",
    type: "LOCAL",
  });
  return request<ListEnvelope<GenFarmerApp>>(`/automation/apps?${query}`);
}

export function getApp(id: string) {
  return request<GenFarmerApp>(`/automation/apps/${encodeURIComponent(id)}`);
}

export function getTasks() {
  const query = new URLSearchParams({
    userId: String(appConfig.genFarmerUserId),
    name: "",
    limit: "100",
    page: "1",
    order: "desc",
    orderBy: "updatedAt",
  });
  return request<ListEnvelope<GenFarmerTask>>(`/automation/tasks?${query}`);
}

export function getTask(id: string) {
  return request<GenFarmerTask>(`/automation/tasks/${encodeURIComponent(id)}`);
}

export function importApp(packageText: string) {
  return request<GenFarmerApp>("/automation/apps/import", {
    method: "POST",
    body: JSON.stringify({ data: packageText }),
  });
}

export function createTask(input: {
  appId: string;
  name: string;
  taskInput: unknown[];
}) {
  return request<GenFarmerTask>("/automation/tasks", {
    method: "POST",
    body: JSON.stringify({
      userId: appConfig.genFarmerUserId,
      appId: input.appId,
      name: input.name,
      input: input.taskInput,
      enableInput: input.taskInput.length > 0,
      devices: { enable: false, list: [] },
    }),
  });
}

export function addTaskDevice(
  taskId: string,
  device: { id: string; serialNo: string; name?: string },
) {
  return request<unknown>(
    `/automation/tasks/${encodeURIComponent(taskId)}/add-devices`,
    {
      method: "PUT",
      body: JSON.stringify({ devices: { list: [device] } }),
    },
  );
}

export function updateTask(task: GenFarmerTask) {
  return request<GenFarmerTask>(
    `/automation/tasks/${encodeURIComponent(task.id)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        name: task.name,
        input: task.input ?? [],
        variables: task.variables ?? [],
        enableInput: task.enableInput ?? true,
        config: task.config,
        devices: task.devices,
      }),
    },
  );
}

export function createRun(appId: string, taskId: string) {
  return request<GenFarmerRun>("/automation/runs", {
    method: "POST",
    body: JSON.stringify({
      userId: appConfig.genFarmerUserId,
      appId,
      taskId,
      status: 0,
    }),
  });
}

export function getRun(id: string) {
  return request<GenFarmerRun>(`/automation/runs/${encodeURIComponent(id)}`);
}

export function getRunLogs(id: string, deviceId: string) {
  const query = new URLSearchParams({ deviceId });
  return request<{ deviceId: string; content: unknown[] }>(
    `/automation/runs/${encodeURIComponent(id)}/logs?${query}`,
  );
}

export function getRunStorages(id: string) {
  const query = new URLSearchParams({ limit: "20", page: "1" });
  return request<ListEnvelope<GenFarmerRunStorage>>(
    `/automation/runs/${encodeURIComponent(id)}/storages?${query}`,
  );
}

export function stopRun(id: string) {
  return request<unknown>(`/automation/runs/${encodeURIComponent(id)}/stop`, {
    method: "PUT",
  });
}
