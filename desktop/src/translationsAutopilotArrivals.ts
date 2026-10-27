// What arrived from outside, as Autopilote "Aujourd'hui" and the notifications
// name it: what it is and how it came. Names and numbers stay verbatim.
// Order: German (Switzerland), Italian, English.
export const autopilotArrivalsTranslations: Record<string, readonly [string, string, string]> = {
  'par un assistant (MCP)': ['über einen Assistenten (MCP)', 'tramite un assistente (MCP)', 'through an assistant (MCP)'],
  'par l’API': ['über die API', 'tramite l’API', 'through the API'],
  'par {platform}': ['über {platform}', 'tramite {platform}', 'through {platform}'],
  'Devis à préparer': ['Offerte vorzubereiten', 'Preventivo da preparare', 'Quote to prepare'],
  'Commande à valider': ['Bestellung zu bestätigen', 'Ordine da approvare', 'Order to approve'],
  'Nouveau client': ['Neuer Kunde', 'Nuovo cliente', 'New customer'],
  'Paiement reçu': ['Zahlung erhalten', 'Pagamento ricevuto', 'Payment received'],
  'Commande annulée': ['Bestellung storniert', 'Ordine annullato', 'Order cancelled'],
};
