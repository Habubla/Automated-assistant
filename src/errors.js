export class JuneMemoryError extends Error {
  constructor(message, code = "JUNE_MEMORY_ERROR") {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class ValidationError extends JuneMemoryError {
  constructor(message) {
    super(message, "VALIDATION_ERROR");
  }
}

export class ConflictError extends JuneMemoryError {
  constructor(message) {
    super(message, "CONFLICT");
  }
}

export class CorruptRecordError extends JuneMemoryError {
  constructor(file, detail) {
    super(`Corrupt memory record at ${file}: ${detail}`, "CORRUPT_RECORD");
  }
}

export class ProviderUnavailableError extends JuneMemoryError {
  constructor(message) {
    super(message, "PROVIDER_UNAVAILABLE");
  }
}
