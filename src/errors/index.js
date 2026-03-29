// ─── Error taxonomy ──────────────────────────────────────────────────────────

'use strict';

function AppError(message, code, metadata) {
  this.name = 'AppError';
  this.message = message || 'Errore applicativo';
  this.code = code || 'APP_ERROR';
  this.metadata = metadata || {};
  Error.captureStackTrace(this, this.constructor);
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function UserInputError(message, metadata) {
  AppError.call(this, message || 'Input non valido', 'USER_INPUT_ERROR', metadata);
  this.name = 'UserInputError';
}
UserInputError.prototype = Object.create(AppError.prototype);
UserInputError.prototype.constructor = UserInputError;

function ExternalServiceError(message, metadata) {
  AppError.call(this, message || 'Servizio esterno non disponibile', 'EXTERNAL_SERVICE_ERROR', metadata);
  this.name = 'ExternalServiceError';
}
ExternalServiceError.prototype = Object.create(AppError.prototype);
ExternalServiceError.prototype.constructor = ExternalServiceError;

function PermissionError(message, metadata) {
  AppError.call(this, message || 'Permesso negato', 'PERMISSION_ERROR', metadata);
  this.name = 'PermissionError';
}
PermissionError.prototype = Object.create(AppError.prototype);
PermissionError.prototype.constructor = PermissionError;

function TransientError(message, metadata) {
  ExternalServiceError.call(this, message || 'Errore transitorio', metadata);
  this.name = 'TransientError';
  this.code = 'TRANSIENT_ERROR';
}
TransientError.prototype = Object.create(ExternalServiceError.prototype);
TransientError.prototype.constructor = TransientError;

function TimeoutError(message, metadata) {
  TransientError.call(this, message || 'Operazione in timeout', metadata);
  this.name = 'TimeoutError';
  this.code = 'TIMEOUT_ERROR';
}
TimeoutError.prototype = Object.create(TransientError.prototype);
TimeoutError.prototype.constructor = TimeoutError;

function isTransientError(e) {
  return !!e && (e.name === 'TransientError' || e.name === 'TimeoutError' || e.code === 'TRANSIENT_ERROR' || e.code === 'TIMEOUT_ERROR');
}

module.exports = {
  AppError: AppError,
  UserInputError: UserInputError,
  ExternalServiceError: ExternalServiceError,
  PermissionError: PermissionError,
  TransientError: TransientError,
  TimeoutError: TimeoutError,
  isTransientError: isTransientError,
};
