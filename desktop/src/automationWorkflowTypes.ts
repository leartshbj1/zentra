export type WorkflowDefinition = {
  trigger:'email_classified'; mode:'shadow'|'suggest'|'automatic'|'notify'; threshold:number;
  conditions:{ category:string; priority:string; sender:string; attachment:boolean; };
  decision:{ question:string; yes:string; no:string; } | null;
  actions:{ type:'task'|'notify'|'reply_draft'|'summary'|'review'; title:string; body:string; delayHours:number; branch:'always'|'yes'|'no'; assignedTo:string; }[];
};
