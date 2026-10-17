let sender = async () => ({ sesMessageId: "fixture-send" });
export function setSender(value) { sender = value; }
export async function sendSesEmail(input) { return sender(input); }
