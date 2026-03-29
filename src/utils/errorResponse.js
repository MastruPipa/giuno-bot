// ─── User-facing error mapping ───────────────────────────────────────────────

'use strict';

function toUserErrorMessage(err) {
  if (!err) return 'Si è verificato un problema temporaneo. Riprova tra poco.';

  if (err.name === 'PermissionError' || err.code === 'PERMISSION_ERROR') {
    return 'Non hai i permessi per questa operazione.';
  }

  if (err.name === 'UserInputError' || err.code === 'USER_INPUT_ERROR') {
    return err.message || 'Controlla i dati inseriti e riprova.';
  }

  if (err.name === 'TimeoutError' || err.code === 'TIMEOUT_ERROR') {
    return 'Sto impiegando troppo tempo a rispondere. Riprova tra poco.';
  }

  if (err.name === 'TransientError' || err.code === 'TRANSIENT_ERROR') {
    return 'Servizio temporaneamente non disponibile. Riprova tra poco.';
  }

  if (err.name === 'ExternalServiceError' || err.code === 'EXTERNAL_SERVICE_ERROR') {
    return 'Un servizio esterno non è disponibile in questo momento. Riprova tra poco.';
  }

  return 'Si è verificato un errore inatteso. Riprova tra poco.';
}

module.exports = {
  toUserErrorMessage: toUserErrorMessage,
};
