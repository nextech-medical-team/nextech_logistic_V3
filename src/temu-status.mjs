/** Adapt TEMU text to the shared delivery vocabulary; TEMU numeric codes are unrelated. */
export function normalizeTemuDeliveryStatus(label) {
  const text = (label || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.!]$/, '');
  if (/^(delivered|delivered successfully|delivery completed|livre|colis livre|votre colis est livre|le colis a ete livre)$/.test(text) || /^delivered by .+/.test(text)) {
    return {code: 'DELIVERED', label: 'Delivered'};
  }
  if (/^(out for delivery|the driver is out for delivery.*|le chauffeur est en train de livrer|le chauffeur est en route pour la livraison|en cours de livraison|livraison en cours)$/.test(text)) {
    return {label: 'The driver is out for delivery'};
  }
  if (/^(en cours|en transit|in transit|votre colis est en transit sur nos plateformes logistiques|colis en cours d['’]acheminement|votre colis est en cours d['’]acheminement|the package is in transit)$/.test(text)) { return {code: 'INTRANSIT', label: 'In transit'}; }
  if (/^(sorti du depot|sortie du depot)$/.test(text)) { return {label: 'The package left sorting center'}; }
  if (/^arrive au depot$/.test(text)) { return {label: 'Arrived at sorting center'}; }
  if (/^(the (package|parcel) has |the package |le colis a )?(left sorting cent(er|re)|quitte le centre de tri)$/.test(text)) {
    return {label: 'The package left sorting center'};
  }
  if (/^(the (package|parcel) has |le colis a )?(arrived at sorting cent(er|re)|atteint le centre de tri)$/.test(text)
    || /^(votre colis a ete pris en charge au centre de tri|votre colis est arrive a l['’]agence regionale gofo de destination|arrived at gofo regional destination facility)$/.test(text)) {
    return {label: 'Arrived at sorting center'};
  }
  if (/^(data received|donnees recues|label created|etiquette creee)$/.test(text)) {
    return {label: 'Informations reçues'};
  }
  return {};
}

