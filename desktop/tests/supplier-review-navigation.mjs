/** Confirm the supplier review, including explicit fixture choices, then return to the list. */
export async function confirmSupplierReview(page) {
  const review = page.getByRole('dialog', { name: 'Vérifier la facture fournisseur', exact: true });
  await review.waitFor();
  for (const label of ['Je valide sans justificatif joint.', 'Je garde cette facture indépendante de la commande.']) {
    const choice = review.getByLabel(label, { exact: true });
    if (await choice.count()) await choice.check();
  }
  await review.getByRole('button', { name: 'Valider et comptabiliser', exact: true }).click();
  const completed = page.getByRole('dialog', { name: 'Facture fournisseur validée', exact: true });
  await completed.getByRole('button', { name: 'Terminer', exact: true }).click();
  await completed.waitFor({ state: 'hidden' });
}
