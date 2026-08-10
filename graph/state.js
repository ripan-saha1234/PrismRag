import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  prompt: Annotation({
    reducer: (_, next) => next ?? "",
    default: () => "",
  }),
  aismsg: Annotation({
    reducer: (_, next) => next ?? "",
    default: () => "",
  }),
});
