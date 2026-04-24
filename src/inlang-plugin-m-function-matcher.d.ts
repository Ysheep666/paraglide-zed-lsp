declare module "@inlang/plugin-m-function-matcher" {
	export type MessageReferencePosition = {
		line: number;
		character: number;
	};

	export type MessageReference = {
		messageId: string;
		position: {
			start: MessageReferencePosition;
			end: MessageReferencePosition;
		};
	};

	export type MessageReferenceMatcher = (args: {
		documentText: string;
	}) => Promise<MessageReference[]>;

	const plugin: {
		meta: {
			"app.inlang.ideExtension": {
				messageReferenceMatchers: MessageReferenceMatcher[];
			};
		};
	};

	export default plugin;
}
