import { ZodError } from "zod";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    message: string,
    status = 500,
    code = "INTERNAL_ERROR",
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof ZodError) {
    return Response.json(
      {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Revisa los datos ingresados.",
        details: error.flatten(),
      },
      { status: 400 },
    );
  }

  if (error instanceof AppError) {
    return Response.json(
      {
        success: false,
        code: error.code,
        message: error.message,
        details: error.details,
      },
      { status: error.status },
    );
  }

  console.error(error);
  return Response.json(
    {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Ocurrió un error inesperado.",
    },
    { status: 500 },
  );
}

export async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new AppError("El cuerpo debe ser JSON válido.", 400, "INVALID_JSON");
  }
}
