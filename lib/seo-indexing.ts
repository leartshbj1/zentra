const privateRoots = ['/api', '/compte', '/connexion', '/mot-de-passe', '/appareil', '/invitation', '/paiement', '/support/admin', '/support/espace', '/support/demo'];

export function isPrivateSearchPath(path: string) {
  return privateRoots.some(root => path === root || path.startsWith(`${root}/`));
}
