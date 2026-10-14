// A reread keeps the preparation hold; its message must reflect the selected
// delivery and carrier without claiming that a label has been created.
export function recoveredPreparationIssue(order, state) {
 const choices={gls:'GLS',gls_pharma:'GLS Pharma',gls_shop:'GLS relais',gofo:'GOFO'};
 const carrier=choices[order.transport_choice];
 if(carrier&&state.bl?.id&&state.bl.status==='ready_to_ship')
  return `BL Erplain prêt à livrer : vérifier puis créer l’étiquette ${carrier} manuellement`;
 return 'Commande Erplain validée : choisir le circuit de préparation';
}
