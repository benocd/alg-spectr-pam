export interface Env {
  DB: D1Database;
  SENSOR_API_KEY: string;
}

type SensorPayload = {
  device_id?: string;
  timestamp?: string;
  temperature_c?: number;
  pam?: {
    t_ms?: number[];
    adc?: number[];
    f0?: number;
    fm?: number;
    min?: number;
    max?: number;
    qy?: number;
  };
  spectral?: Record<string, number>;
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
    },
  });
}

function calculatePam(payload: SensorPayload) {
  const adc = payload.pam?.adc;

  let f0 = payload.pam?.f0 ?? payload.pam?.min;
  let fm = payload.pam?.fm ?? payload.pam?.max;
  let qy = payload.pam?.qy;

  if ((!Number.isFinite(f0) || !Number.isFinite(fm)) && Array.isArray(adc) && adc.length > 0) {
    f0 = Math.min(...adc);
    fm = Math.max(...adc);
  }

  if (!Number.isFinite(qy) && Number.isFinite(f0) && Number.isFinite(fm) && fm && fm > 0) {
    qy = (fm - f0) / fm;
  }

  return {
    f0: Number.isFinite(f0) ? Math.round(Number(f0)) : null,
    fm: Number.isFinite(fm) ? Math.round(Number(fm)) : null,
    qy: Number.isFinite(qy) ? Number(qy) : null,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "pbr-sensor-api",
      });
    }

    if (request.method === "POST" && url.pathname === "/readings") {
      const apiKey = request.headers.get("x-api-key");

      if (!apiKey || apiKey !== env.SENSOR_API_KEY) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }

      let payload: SensorPayload;

      try {
        payload = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
      }

      const deviceId = payload.device_id;
      const recordedAt = payload.timestamp;
      const temperature = payload.temperature_c ?? null;

      if (!deviceId) {
        return jsonResponse({ ok: false, error: "Missing device_id" }, 400);
      }

      if (!recordedAt) {
        return jsonResponse({ ok: false, error: "Missing timestamp" }, 400);
      }

      const { f0, fm, qy } = calculatePam(payload);

      const payloadJson = JSON.stringify(payload);

      const result = await env.DB.prepare(
        `
        INSERT INTO sensor_readings (
          device_id,
          recorded_at,
          temperature_c,
          f0,
          fm,
          qy,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id, created_at;
        `
      )
        .bind(
          deviceId,
          recordedAt,
          temperature,
          f0,
          fm,
          qy,
          payloadJson
        )
        .first();

      return jsonResponse({
        ok: true,
        inserted: result,
        summary: {
          device_id: deviceId,
          recorded_at: recordedAt,
          temperature_c: temperature,
          f0,
          fm,
          qy,
        },
      });
    }

    return jsonResponse(
      {
        ok: false,
        error: "Not found",
        routes: [
          "GET /health",
          "POST /readings",
        ],
      },
      404
    );
  },
};