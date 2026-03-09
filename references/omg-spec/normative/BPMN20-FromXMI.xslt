<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0"
	xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:xmi="http://schema.omg.org/spec/XMI"
	xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
	xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
	xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:bpmnxmi="http://www.omg.org/spec/BPMN/20100524/MODEL-XMI"
	xmlns:bpmndixmi="http://www.omg.org/spec/BPMN/20100524/DI-XMI"
	xmlns:dixmi="http://www.omg.org/spec/DD/20100524/DI-XMI" xmlns:dcxmi="http://www.omg.org/spec/DD/20100524/DC-XMI">
	<xsl:output method="xml" version="1.0" encoding="UTF-8" indent="yes" />

	<xsl:template match="/">
		<xsl:apply-templates />
	</xsl:template>

	<xsl:template name="EObjectTemplate">
		<!-- TODO: Add your copy logic for extension attributes-->
	</xsl:template>

	<xsl:template name="InterfaceTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@implementationRef">
			<xsl:attribute name="implementationRef"> <xsl:value-of select="@implementationRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="operations">
			<bpmn:operation>
				<xsl:call-template name="OperationTemplate" />
			</bpmn:operation>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="RootElementTemplate">
		<xsl:call-template name="BaseElementTemplate" />
	</xsl:template>

	<xsl:template name="BaseElementTemplate">
		<xsl:if test="@id">
			<xsl:attribute name="id"> <xsl:value-of select="@id" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="extensionValues">
			<bpmn:extensionValues>
				<xsl:call-template name="ExtensionAttributeValueTemplate" />
			</bpmn:extensionValues>
		</xsl:for-each>


		<xsl:for-each select="documentation">
			<bpmn:documentation>
				<xsl:call-template name="DocumentationTemplate" />
			</bpmn:documentation>
		</xsl:for-each>

		<xsl:if test="@extensionDefinitions">
			<xsl:attribute name="extensionDefinitions"> <xsl:value-of
				select="@extensionDefinitions" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ExtensionDefinitionTemplate">
		<bpmn:name>
			<xsl:value-of select="@name" />
		</bpmn:name>

		<xsl:for-each select="extensionAttributeDefinitions">
			<bpmn:extensionAttributeDefinitions>
				<xsl:call-template name="ExtensionAttributeDefinitionTemplate" />
			</bpmn:extensionAttributeDefinitions>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ExtensionAttributeDefinitionTemplate">
		<bpmn:name>
			<xsl:value-of select="@name" />
		</bpmn:name>

		<bpmn:type>
			<xsl:value-of select="@type" />
		</bpmn:type>

		<bpmn:isReference>
			<xsl:value-of select="@isReference" />
		</bpmn:isReference>
		<xsl:if test="@extensionDefinition">
			<xsl:attribute name="extensionDefinition"> <xsl:value-of
				select="@extensionDefinition" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ExtensionAttributeValueTemplate">
		<xsl:if test="@valueRef">
			<xsl:attribute name="valueRef"> <xsl:value-of select="@valueRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="value">
			<bpmn:value>
				<xsl:call-template name="EObjectTemplate" />
			</bpmn:value>
		</xsl:for-each>

		<xsl:if test="@extensionAttributeDefinition">
			<xsl:attribute name="extensionAttributeDefinition"> <xsl:value-of
				select="@extensionAttributeDefinition" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="DocumentationTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@textFormat">
			<xsl:attribute name="textFormat"> <xsl:value-of select="@textFormat" /> </xsl:attribute>
		</xsl:if>

		<bpmn:text>
			<xsl:value-of select="@text" />
		</bpmn:text>
	</xsl:template>

	<xsl:template name="OperationTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@implementationRef">
			<xsl:attribute name="implementationRef"> <xsl:value-of select="@implementationRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@inMessageRef">
			<xsl:attribute name="inMessageRef"> <xsl:value-of select="@inMessageRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@outMessageRef">
			<xsl:attribute name="outMessageRef"> <xsl:value-of select="@outMessageRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@errorRefs">
			<xsl:attribute name="errorRefs"> <xsl:value-of select="@errorRefs" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="MessageTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@itemRef">
			<xsl:attribute name="itemRef"> <xsl:value-of select="@itemRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ItemDefinitionTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@itemKind">
			<xsl:attribute name="itemKind"> <xsl:value-of select="@itemKind" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@structureRef">
			<xsl:attribute name="structureRef"> <xsl:value-of select="@structureRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isCollection">
			<xsl:attribute name="isCollection"> <xsl:value-of select="@isCollection" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@import">
			<xsl:attribute name="import"> <xsl:value-of select="@import" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ImportTemplate">
		<xsl:if test="@importType">
			<xsl:attribute name="importType"> <xsl:value-of select="@importType" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@location">
			<xsl:attribute name="location"> <xsl:value-of select="@location" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@namespace">
			<xsl:attribute name="namespace"> <xsl:value-of select="@namespace" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ErrorTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@structureRef">
			<xsl:attribute name="structureRef"> <xsl:value-of select="@structureRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@errorCode">
			<xsl:attribute name="errorCode"> <xsl:value-of select="@errorCode" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="EndPointTemplate">
		<xsl:call-template name="RootElementTemplate" />
	</xsl:template>

	<xsl:template name="AuditingTemplate">
		<xsl:call-template name="BaseElementTemplate" />
	</xsl:template>

	<xsl:template name="GlobalTaskTemplate">
		<xsl:call-template name="CallableElementTemplate" />

		<xsl:for-each
			select="resources[contains(@xmi:type, 'Performer') or contains(@xsi:type, 'Performer')]">
			<bpmn:performer>
				<xsl:call-template name="PerformerTemplate" />
			</bpmn:performer>
		</xsl:for-each>
		<xsl:for-each
			select="resources[contains(@xmi:type, 'HumanPerformer') or contains(@xsi:type, 'HumanPerformer')]">
			<bpmn:humanPerformer>
				<xsl:call-template name="HumanPerformerTemplate" />
			</bpmn:humanPerformer>
		</xsl:for-each>
		<xsl:for-each
			select="resources[contains(@xmi:type, 'PotentialOwner') or contains(@xsi:type, 'PotentialOwner')]">
			<bpmn:potentialOwner>
				<xsl:call-template name="PotentialOwnerTemplate" />
			</bpmn:potentialOwner>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="CallableElementTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@supportedInterfaceRefs">
			<xsl:attribute name="supportedInterfaceRefs"> <xsl:value-of
				select="@supportedInterfaceRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="ioSpecification">
			<bpmn:ioSpecification>
				<xsl:call-template name="InputOutputSpecificationTemplate" />
			</bpmn:ioSpecification>
		</xsl:for-each>


		<xsl:for-each select="ioBinding">
			<bpmn:ioBinding>
				<xsl:call-template name="InputOutputBindingTemplate" />
			</bpmn:ioBinding>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="InputOutputSpecificationTemplate">
		<xsl:call-template name="BaseElementTemplate" />

		<xsl:for-each select="dataInputs">
			<bpmn:dataInput>
				<xsl:call-template name="DataInputTemplate" />
			</bpmn:dataInput>
		</xsl:for-each>


		<xsl:for-each select="dataOutputs">
			<bpmn:dataOutput>
				<xsl:call-template name="DataOutputTemplate" />
			</bpmn:dataOutput>
		</xsl:for-each>


		<xsl:for-each select="inputSets">
			<bpmn:inputSet>
				<xsl:call-template name="InputSetTemplate" />
			</bpmn:inputSet>
		</xsl:for-each>


		<xsl:for-each select="outputSets">
			<bpmn:outputSet>
				<xsl:call-template name="OutputSetTemplate" />
			</bpmn:outputSet>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="InputSetTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@dataInputRefs">
			<xsl:attribute name="dataInputRefs"> <xsl:value-of select="@dataInputRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@optionalInputRefs">
			<xsl:attribute name="optionalInputRefs"> <xsl:value-of select="@optionalInputRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@whileExecutingInputRefs">
			<xsl:attribute name="whileExecutingInputRefs"> <xsl:value-of
				select="@whileExecutingInputRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@outputSetRefs">
			<xsl:attribute name="outputSetRefs"> <xsl:value-of select="@outputSetRefs" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="DataInputTemplate">
		<xsl:call-template name="ItemAwareElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isCollection">
			<xsl:attribute name="isCollection"> <xsl:value-of select="@isCollection" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@inputSetWithOptional">
			<xsl:attribute name="inputSetWithOptional"> <xsl:value-of
				select="@inputSetWithOptional" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@inputSetWithWhileExecuting">
			<xsl:attribute name="inputSetWithWhileExecuting"> <xsl:value-of
				select="@inputSetWithWhileExecuting" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@inputSetRefs">
			<xsl:attribute name="inputSetRefs"> <xsl:value-of select="@inputSetRefs" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ItemAwareElementTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@itemSubjectRef">
			<xsl:attribute name="itemSubjectRef"> <xsl:value-of select="@itemSubjectRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="dataState">
			<bpmn:dataState>
				<xsl:call-template name="DataStateTemplate" />
			</bpmn:dataState>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="DataStateTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="OutputSetTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@dataOutputRefs">
			<xsl:attribute name="dataOutputRefs"> <xsl:value-of select="@dataOutputRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@optionalOutputRefs">
			<xsl:attribute name="optionalOutputRefs"> <xsl:value-of
				select="@optionalOutputRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@whileExecutingOutputRefs">
			<xsl:attribute name="whileExecutingOutputRefs"> <xsl:value-of
				select="@whileExecutingOutputRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@inputSetRefs">
			<xsl:attribute name="inputSetRefs"> <xsl:value-of select="@inputSetRefs" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="DataOutputTemplate">
		<xsl:call-template name="ItemAwareElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isCollection">
			<xsl:attribute name="isCollection"> <xsl:value-of select="@isCollection" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@outputSetWithOptional">
			<xsl:attribute name="outputSetWithOptional"> <xsl:value-of
				select="@outputSetWithOptional" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@outputSetWithWhileExecuting">
			<xsl:attribute name="outputSetWithWhileExecuting"> <xsl:value-of
				select="@outputSetWithWhileExecuting" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@outputSetRefs">
			<xsl:attribute name="outputSetRefs"> <xsl:value-of select="@outputSetRefs" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="InputOutputBindingTemplate">
		<xsl:if test="@inputDataRef">
			<xsl:attribute name="inputDataRef"> <xsl:value-of select="@inputDataRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@outputDataRef">
			<xsl:attribute name="outputDataRef"> <xsl:value-of select="@outputDataRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@operationRef">
			<xsl:attribute name="operationRef"> <xsl:value-of select="@operationRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ResourceRoleTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@resourceRef">
			<xsl:attribute name="resourceRef"> <xsl:value-of select="@resourceRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="resourceParameterBindings">
			<bpmn:resourceParameterBinding>
				<xsl:call-template name="ResourceParameterBindingTemplate" />
			</bpmn:resourceParameterBinding>
		</xsl:for-each>


		<xsl:for-each select="resourceAssignmentExpression">
			<bpmn:resourceAssignmentExpression>
				<xsl:call-template name="ResourceAssignmentExpressionTemplate" />
			</bpmn:resourceAssignmentExpression>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ResourceTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="resourceParameters">
			<bpmn:resourceParameter>
				<xsl:call-template name="ResourceParameterTemplate" />
			</bpmn:resourceParameter>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ResourceParameterTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isRequired">
			<xsl:attribute name="isRequired"> <xsl:value-of select="@isRequired" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@type">
			<xsl:attribute name="type"> <xsl:value-of select="@type" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ResourceParameterBindingTemplate">
		<xsl:if test="@parameterRef">
			<xsl:attribute name="parameterRef"> <xsl:value-of select="@parameterRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each
			select="expression[contains(@xmi:type, 'FormalExpression') or contains(@xsi:type, 'FormalExpression')]">
			<bpmn:formalExpression>
				<xsl:call-template name="FormalExpressionTemplate" />
			</bpmn:formalExpression>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ExpressionTemplate">
		<xsl:call-template name="BaseElementTemplate" />
	</xsl:template>

	<xsl:template name="ResourceAssignmentExpressionTemplate">

		<xsl:for-each
			select="expression[contains(@xmi:type, 'FormalExpression') or contains(@xsi:type, 'FormalExpression')]">
			<bpmn:formalExpression>
				<xsl:call-template name="FormalExpressionTemplate" />
			</bpmn:formalExpression>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="MonitoringTemplate">
		<xsl:call-template name="BaseElementTemplate" />
	</xsl:template>

	<xsl:template name="PerformerTemplate">
		<xsl:call-template name="ResourceRoleTemplate" />
	</xsl:template>

	<xsl:template name="ProcessTemplate">
		<xsl:call-template name="CallableElementTemplate" />
		<xsl:call-template name="FlowElementsContainerTemplate" />
		<xsl:if test="@processType">
			<xsl:attribute name="processType"> <xsl:value-of select="@processType" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isClosed">
			<xsl:attribute name="isClosed"> <xsl:value-of select="@isClosed" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@definitionalCollaborationRef">
			<xsl:attribute name="definitionalCollaborationRef"> <xsl:value-of
				select="@definitionalCollaborationRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isExecutable">
			<xsl:attribute name="isExecutable"> <xsl:value-of select="@isExecutable" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="auditing">
			<bpmn:auditing>
				<xsl:call-template name="AuditingTemplate" />
			</bpmn:auditing>
		</xsl:for-each>


		<xsl:for-each select="monitoring">
			<bpmn:monitoring>
				<xsl:call-template name="MonitoringTemplate" />
			</bpmn:monitoring>
		</xsl:for-each>


		<xsl:for-each select="properties">
			<bpmn:property>
				<xsl:call-template name="PropertyTemplate" />
			</bpmn:property>
		</xsl:for-each>


		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'Association') or contains(@xsi:type, 'Association')]">
			<bpmn:association>
				<xsl:call-template name="AssociationTemplate" />
			</bpmn:association>
		</xsl:for-each>
		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'Group') or contains(@xsi:type, 'Group')]">
			<bpmn:group>
				<xsl:call-template name="GroupTemplate" />
			</bpmn:group>
		</xsl:for-each>
		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'TextAnnotation') or contains(@xsi:type, 'TextAnnotation')]">
			<bpmn:textAnnotation>
				<xsl:call-template name="TextAnnotationTemplate" />
			</bpmn:textAnnotation>
		</xsl:for-each>


		<xsl:for-each
			select="resources[contains(@xmi:type, 'Performer') or contains(@xsi:type, 'Performer')]">
			<bpmn:performer>
				<xsl:call-template name="PerformerTemplate" />
			</bpmn:performer>
		</xsl:for-each>
		<xsl:for-each
			select="resources[contains(@xmi:type, 'HumanPerformer') or contains(@xsi:type, 'HumanPerformer')]">
			<bpmn:humanPerformer>
				<xsl:call-template name="HumanPerformerTemplate" />
			</bpmn:humanPerformer>
		</xsl:for-each>
		<xsl:for-each
			select="resources[contains(@xmi:type, 'PotentialOwner') or contains(@xsi:type, 'PotentialOwner')]">
			<bpmn:potentialOwner>
				<xsl:call-template name="PotentialOwnerTemplate" />
			</bpmn:potentialOwner>
		</xsl:for-each>


		<xsl:for-each select="correlationSubscriptions">
			<bpmn:correlationSubscription>
				<xsl:call-template name="CorrelationSubscriptionTemplate" />
			</bpmn:correlationSubscription>
		</xsl:for-each>


		<xsl:if test="@supports">
			<xsl:attribute name="supports"> <xsl:value-of select="@supports" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="FlowElementsContainerTemplate">
		<xsl:call-template name="BaseElementTemplate" />

		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'AdHocSubProcess') or contains(@xsi:type, 'AdHocSubProcess')]">
			<bpmn:adHocSubProcess>
				<xsl:call-template name="AdHocSubProcessTemplate" />
			</bpmn:adHocSubProcess>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'BoundaryEvent') or contains(@xsi:type, 'BoundaryEvent')]">
			<bpmn:boundaryEvent>
				<xsl:call-template name="BoundaryEventTemplate" />
			</bpmn:boundaryEvent>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'BusinessRuleTask') or contains(@xsi:type, 'BusinessRuleTask')]">
			<bpmn:businessRuleTask>
				<xsl:call-template name="BusinessRuleTaskTemplate" />
			</bpmn:businessRuleTask>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'CallActivity') or contains(@xsi:type, 'CallActivity')]">
			<bpmn:callActivity>
				<xsl:call-template name="CallActivityTemplate" />
			</bpmn:callActivity>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'CallChoreography') or contains(@xsi:type, 'CallChoreography')]">
			<bpmn:callChoreography>
				<xsl:call-template name="CallChoreographyTemplate" />
			</bpmn:callChoreography>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'ChoreographyTask') or contains(@xsi:type, 'ChoreographyTask')]">
			<bpmn:choreographyTask>
				<xsl:call-template name="ChoreographyTaskTemplate" />
			</bpmn:choreographyTask>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'ComplexGateway') or contains(@xsi:type, 'ComplexGateway')]">
			<bpmn:complexGateway>
				<xsl:call-template name="ComplexGatewayTemplate" />
			</bpmn:complexGateway>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'DataObject') or contains(@xsi:type, 'DataObject')]">
			<bpmn:dataObject>
				<xsl:call-template name="DataObjectTemplate" />
			</bpmn:dataObject>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'DataObjectReference') or contains(@xsi:type, 'DataObjectReference')]">
			<bpmn:dataObjectReference>
				<xsl:call-template name="DataObjectReferenceTemplate" />
			</bpmn:dataObjectReference>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'DataStoreReference') or contains(@xsi:type, 'DataStoreReference')]">
			<bpmn:dataStoreReference>
				<xsl:call-template name="DataStoreReferenceTemplate" />
			</bpmn:dataStoreReference>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'EndEvent') or contains(@xsi:type, 'EndEvent')]">
			<bpmn:endEvent>
				<xsl:call-template name="EndEventTemplate" />
			</bpmn:endEvent>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'Event') or contains(@xsi:type, 'Event')]">
			<bpmn:event>
				<xsl:call-template name="EventTemplate" />
			</bpmn:event>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'EventBasedGateway') or contains(@xsi:type, 'EventBasedGateway')]">
			<bpmn:eventBasedGateway>
				<xsl:call-template name="EventBasedGatewayTemplate" />
			</bpmn:eventBasedGateway>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'ExclusiveGateway') or contains(@xsi:type, 'ExclusiveGateway')]">
			<bpmn:exclusiveGateway>
				<xsl:call-template name="ExclusiveGatewayTemplate" />
			</bpmn:exclusiveGateway>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'ImplicitThrowEvent') or contains(@xsi:type, 'ImplicitThrowEvent')]">
			<bpmn:implicitThrowEvent>
				<xsl:call-template name="ImplicitThrowEventTemplate" />
			</bpmn:implicitThrowEvent>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'InclusiveGateway') or contains(@xsi:type, 'InclusiveGateway')]">
			<bpmn:inclusiveGateway>
				<xsl:call-template name="InclusiveGatewayTemplate" />
			</bpmn:inclusiveGateway>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'IntermediateCatchEvent') or contains(@xsi:type, 'IntermediateCatchEvent')]">
			<bpmn:intermediateCatchEvent>
				<xsl:call-template name="IntermediateCatchEventTemplate" />
			</bpmn:intermediateCatchEvent>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'IntermediateThrowEvent') or contains(@xsi:type, 'IntermediateThrowEvent')]">
			<bpmn:intermediateThrowEvent>
				<xsl:call-template name="IntermediateThrowEventTemplate" />
			</bpmn:intermediateThrowEvent>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'ManualTask') or contains(@xsi:type, 'ManualTask')]">
			<bpmn:manualTask>
				<xsl:call-template name="ManualTaskTemplate" />
			</bpmn:manualTask>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'ParallelGateway') or contains(@xsi:type, 'ParallelGateway')]">
			<bpmn:parallelGateway>
				<xsl:call-template name="ParallelGatewayTemplate" />
			</bpmn:parallelGateway>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'ReceiveTask') or contains(@xsi:type, 'ReceiveTask')]">
			<bpmn:receiveTask>
				<xsl:call-template name="ReceiveTaskTemplate" />
			</bpmn:receiveTask>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'ScriptTask') or contains(@xsi:type, 'ScriptTask')]">
			<bpmn:scriptTask>
				<xsl:call-template name="ScriptTaskTemplate" />
			</bpmn:scriptTask>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'SendTask') or contains(@xsi:type, 'SendTask')]">
			<bpmn:sendTask>
				<xsl:call-template name="SendTaskTemplate" />
			</bpmn:sendTask>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'SequenceFlow') or contains(@xsi:type, 'SequenceFlow')]">
			<bpmn:sequenceFlow>
				<xsl:call-template name="SequenceFlowTemplate" />
			</bpmn:sequenceFlow>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'ServiceTask') or contains(@xsi:type, 'ServiceTask')]">
			<bpmn:serviceTask>
				<xsl:call-template name="ServiceTaskTemplate" />
			</bpmn:serviceTask>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'StartEvent') or contains(@xsi:type, 'StartEvent')]">
			<bpmn:startEvent>
				<xsl:call-template name="StartEventTemplate" />
			</bpmn:startEvent>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'SubChoreography') or contains(@xsi:type, 'SubChoreography')]">
			<bpmn:subChoreography>
				<xsl:call-template name="SubChoreographyTemplate" />
			</bpmn:subChoreography>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'SubProcess') or contains(@xsi:type, 'SubProcess')]">
			<bpmn:subProcess>
				<xsl:call-template name="SubProcessTemplate" />
			</bpmn:subProcess>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'Task') or contains(@xsi:type, 'Task')]">
			<bpmn:task>
				<xsl:call-template name="TaskTemplate" />
			</bpmn:task>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'Transaction') or contains(@xsi:type, 'Transaction')]">
			<bpmn:transaction>
				<xsl:call-template name="TransactionTemplate" />
			</bpmn:transaction>
		</xsl:for-each>
		<xsl:for-each
			select="flowElements[contains(@xmi:type, 'UserTask') or contains(@xsi:type, 'UserTask')]">
			<bpmn:userTask>
				<xsl:call-template name="UserTaskTemplate" />
			</bpmn:userTask>
		</xsl:for-each>


		<xsl:for-each select="laneSets">
			<bpmn:laneSet>
				<xsl:call-template name="LaneSetTemplate" />
			</bpmn:laneSet>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="FlowElementTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="auditing">
			<bpmn:auditing>
				<xsl:call-template name="AuditingTemplate" />
			</bpmn:auditing>
		</xsl:for-each>


		<xsl:for-each select="monitoring">
			<bpmn:monitoring>
				<xsl:call-template name="MonitoringTemplate" />
			</bpmn:monitoring>
		</xsl:for-each>


		<xsl:if test="@categoryValueRef">
			<xsl:attribute name="categoryValueRef"> <xsl:value-of select="@categoryValueRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="CategoryValueTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@value">
			<xsl:attribute name="value"> <xsl:value-of select="@value" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@categorizedFlowElements">
			<xsl:attribute name="categorizedFlowElements"> <xsl:value-of
				select="@categorizedFlowElements" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="LaneSetTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="lanes">
			<bpmn:lane>
				<xsl:call-template name="LaneTemplate" />
			</bpmn:lane>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="LaneTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@partitionElementRef">
			<xsl:attribute name="partitionElementRef"> <xsl:value-of
				select="@partitionElementRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="partitionElement">
			<bpmn:partitionElement>
				<xsl:call-template name="BaseElementTemplate" />
			</bpmn:partitionElement>
		</xsl:for-each>


		<xsl:if test="@flowNodeRefs">
			<xsl:attribute name="flowNodeRefs"> <xsl:value-of select="@flowNodeRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="childLaneSet">
			<bpmn:childLaneSet>
				<xsl:call-template name="LaneSetTemplate" />
			</bpmn:childLaneSet>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="FlowNodeTemplate">
		<xsl:call-template name="FlowElementTemplate" />

		<xsl:if test="@incoming">
			<xsl:attribute name="incoming"> <xsl:value-of select="@incoming" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@lanes">
			<xsl:attribute name="lanes"> <xsl:value-of select="@lanes" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@outgoing">
			<xsl:attribute name="outgoing"> <xsl:value-of select="@outgoing" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="SequenceFlowTemplate">
		<xsl:call-template name="FlowElementTemplate" />
		<xsl:if test="@isImmediate">
			<xsl:attribute name="isImmediate"> <xsl:value-of select="@isImmediate" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@targetRef">
			<xsl:attribute name="targetRef"> <xsl:value-of select="@targetRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@sourceRef">
			<xsl:attribute name="sourceRef"> <xsl:value-of select="@sourceRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="conditionExpression">
			<bpmn:conditionExpression>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:conditionExpression>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="PropertyTemplate">
		<xsl:call-template name="ItemAwareElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="CollaborationTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isClosed">
			<xsl:attribute name="isClosed"> <xsl:value-of select="@isClosed" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="participants">
			<bpmn:participant>
				<xsl:call-template name="ParticipantTemplate" />
			</bpmn:participant>
		</xsl:for-each>


		<xsl:for-each select="messageFlows">
			<bpmn:messageFlow>
				<xsl:call-template name="MessageFlowTemplate" />
			</bpmn:messageFlow>
		</xsl:for-each>


		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'Association') or contains(@xsi:type, 'Association')]">
			<bpmn:association>
				<xsl:call-template name="AssociationTemplate" />
			</bpmn:association>
		</xsl:for-each>
		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'Group') or contains(@xsi:type, 'Group')]">
			<bpmn:group>
				<xsl:call-template name="GroupTemplate" />
			</bpmn:group>
		</xsl:for-each>
		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'TextAnnotation') or contains(@xsi:type, 'TextAnnotation')]">
			<bpmn:textAnnotation>
				<xsl:call-template name="TextAnnotationTemplate" />
			</bpmn:textAnnotation>
		</xsl:for-each>


		<xsl:for-each
			select="conversations[contains(@xmi:type, 'CallConversation') or contains(@xsi:type, 'CallConversation')]">
			<bpmn:callConversation>
				<xsl:call-template name="CallConversationTemplate" />
			</bpmn:callConversation>
		</xsl:for-each>
		<xsl:for-each
			select="conversations[contains(@xmi:type, 'Conversation') or contains(@xsi:type, 'Conversation')]">
			<bpmn:conversation>
				<xsl:call-template name="ConversationTemplate" />
			</bpmn:conversation>
		</xsl:for-each>
		<xsl:for-each
			select="conversations[contains(@xmi:type, 'SubConversation') or contains(@xsi:type, 'SubConversation')]">
			<bpmn:subConversation>
				<xsl:call-template name="SubConversationTemplate" />
			</bpmn:subConversation>
		</xsl:for-each>


		<xsl:for-each select="conversationAssociations">
			<bpmn:conversationAssociation>
				<xsl:call-template name="ConversationAssociationTemplate" />
			</bpmn:conversationAssociation>
		</xsl:for-each>


		<xsl:for-each select="participantAssociations">
			<bpmn:participantAssociation>
				<xsl:call-template name="ParticipantAssociationTemplate" />
			</bpmn:participantAssociation>
		</xsl:for-each>


		<xsl:for-each select="messageFlowAssociations">
			<bpmn:messageFlowAssociation>
				<xsl:call-template name="MessageFlowAssociationTemplate" />
			</bpmn:messageFlowAssociation>
		</xsl:for-each>


		<xsl:for-each select="correlationKeys">
			<bpmn:correlationKey>
				<xsl:call-template name="CorrelationKeyTemplate" />
			</bpmn:correlationKey>
		</xsl:for-each>


		<xsl:if test="@choreographyRef">
			<xsl:attribute name="choreographyRef"> <xsl:value-of select="@choreographyRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="conversationLinks">
			<bpmn:conversationLink>
				<xsl:call-template name="ConversationLinkTemplate" />
			</bpmn:conversationLink>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ChoreographyTemplate">
		<xsl:call-template name="CollaborationTemplate" />
		<xsl:call-template name="FlowElementsContainerTemplate" />
	</xsl:template>

	<xsl:template name="ArtifactTemplate">
		<xsl:call-template name="BaseElementTemplate" />
	</xsl:template>

	<xsl:template name="ParticipantAssociationTemplate">
		<xsl:call-template name="BaseElementTemplate" />

		<xsl:if test="@innerParticipantRef">
			<xsl:attribute name="innerParticipantRef"> <xsl:value-of
				select="@innerParticipantRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@outerParticipantRef">
			<xsl:attribute name="outerParticipantRef"> <xsl:value-of
				select="@outerParticipantRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ParticipantTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:call-template name="InteractionNodeTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@processRef">
			<xsl:attribute name="processRef"> <xsl:value-of select="@processRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@interfaceRefs">
			<xsl:attribute name="interfaceRefs"> <xsl:value-of select="@interfaceRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@endPointRefs">
			<xsl:attribute name="endPointRefs"> <xsl:value-of select="@endPointRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="participantMultiplicity">
			<bpmn:participantMultiplicity>
				<xsl:call-template name="ParticipantMultiplicityTemplate" />
			</bpmn:participantMultiplicity>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="InteractionNodeTemplate">

		<xsl:if test="@incomingConversationLinks">
			<xsl:attribute name="incomingConversationLinks"> <xsl:value-of
				select="@incomingConversationLinks" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@outgoingConversationLinks">
			<xsl:attribute name="outgoingConversationLinks"> <xsl:value-of
				select="@outgoingConversationLinks" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ConversationLinkTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@sourceRef">
			<xsl:attribute name="sourceRef"> <xsl:value-of select="@sourceRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@targetRef">
			<xsl:attribute name="targetRef"> <xsl:value-of select="@targetRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ParticipantMultiplicityTemplate">
		<xsl:if test="@minimum">
			<xsl:attribute name="minimum"> <xsl:value-of select="@minimum" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@maximum">
			<xsl:attribute name="maximum"> <xsl:value-of select="@maximum" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="MessageFlowAssociationTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@innerMessageFlowRef">
			<xsl:attribute name="innerMessageFlowRef"> <xsl:value-of
				select="@innerMessageFlowRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@outerMessageFlowRef">
			<xsl:attribute name="outerMessageFlowRef"> <xsl:value-of
				select="@outerMessageFlowRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="MessageFlowTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@sourceRef">
			<xsl:attribute name="sourceRef"> <xsl:value-of select="@sourceRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@targetRef">
			<xsl:attribute name="targetRef"> <xsl:value-of select="@targetRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@messageRef">
			<xsl:attribute name="messageRef"> <xsl:value-of select="@messageRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ConversationAssociationTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@innerConversationNodeRef">
			<xsl:attribute name="innerConversationNodeRef"> <xsl:value-of
				select="@innerConversationNodeRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@outerConversationNodeRef">
			<xsl:attribute name="outerConversationNodeRef"> <xsl:value-of
				select="@outerConversationNodeRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ConversationNodeTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:call-template name="InteractionNodeTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@participantRefs">
			<xsl:attribute name="participantRefs"> <xsl:value-of select="@participantRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@messageFlowRefs">
			<xsl:attribute name="messageFlowRefs"> <xsl:value-of select="@messageFlowRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="correlationKeys">
			<bpmn:correlationKey>
				<xsl:call-template name="CorrelationKeyTemplate" />
			</bpmn:correlationKey>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="CorrelationKeyTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@correlationPropertyRef">
			<xsl:attribute name="correlationPropertyRef"> <xsl:value-of
				select="@correlationPropertyRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="CorrelationPropertyTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@type">
			<xsl:attribute name="type"> <xsl:value-of select="@type" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="correlationPropertyRetrievalExpression">
			<bpmn:correlationPropertyRetrievalExpression>
				<xsl:call-template name="CorrelationPropertyRetrievalExpressionTemplate" />
			</bpmn:correlationPropertyRetrievalExpression>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="CorrelationPropertyRetrievalExpressionTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@messageRef">
			<xsl:attribute name="messageRef"> <xsl:value-of select="@messageRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="messagePath">
			<bpmn:messagePath>
				<xsl:call-template name="FormalExpressionTemplate" />
			</bpmn:messagePath>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="FormalExpressionTemplate">
		<xsl:call-template name="ExpressionTemplate" />
		<xsl:if test="@language">
			<xsl:attribute name="language"> <xsl:value-of select="@language" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@evaluatesToTypeRef">
			<xsl:attribute name="evaluatesToTypeRef"> <xsl:value-of
				select="@evaluatesToTypeRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@body">
			<xsl:attribute name="body"> <xsl:value-of select="@body" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="CorrelationSubscriptionTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@correlationKeyRef">
			<xsl:attribute name="correlationKeyRef"> <xsl:value-of select="@correlationKeyRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="correlationPropertyBinding">
			<bpmn:correlationPropertyBinding>
				<xsl:call-template name="CorrelationPropertyBindingTemplate" />
			</bpmn:correlationPropertyBinding>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="CorrelationPropertyBindingTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@correlationPropertyRef">
			<xsl:attribute name="correlationPropertyRef"> <xsl:value-of
				select="@correlationPropertyRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="dataPath">
			<bpmn:dataPath>
				<xsl:call-template name="FormalExpressionTemplate" />
			</bpmn:dataPath>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="GlobalManualTaskTemplate">
		<xsl:call-template name="GlobalTaskTemplate" />
	</xsl:template>

	<xsl:template name="ManualTaskTemplate">
		<xsl:call-template name="TaskTemplate" />
	</xsl:template>

	<xsl:template name="TaskTemplate">
		<xsl:call-template name="ActivityTemplate" />
		<xsl:call-template name="InteractionNodeTemplate" />
	</xsl:template>

	<xsl:template name="ActivityTemplate">
		<xsl:call-template name="FlowNodeTemplate" />
		<xsl:if test="@isForCompensation">
			<xsl:attribute name="isForCompensation"> <xsl:value-of select="@isForCompensation" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@default">
			<xsl:attribute name="default"> <xsl:value-of select="@default" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@startQuantity">
			<xsl:attribute name="startQuantity"> <xsl:value-of select="@startQuantity" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@completionQuantity">
			<xsl:attribute name="completionQuantity"> <xsl:value-of
				select="@completionQuantity" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="ioSpecification">
			<bpmn:ioSpecification>
				<xsl:call-template name="InputOutputSpecificationTemplate" />
			</bpmn:ioSpecification>
		</xsl:for-each>


		<xsl:if test="@boundaryEventRefs">
			<xsl:attribute name="boundaryEventRefs"> <xsl:value-of select="@boundaryEventRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="properties">
			<bpmn:property>
				<xsl:call-template name="PropertyTemplate" />
			</bpmn:property>
		</xsl:for-each>


		<xsl:for-each select="dataInputAssociations">
			<bpmn:dataInputAssociation>
				<xsl:call-template name="DataInputAssociationTemplate" />
			</bpmn:dataInputAssociation>
		</xsl:for-each>


		<xsl:for-each select="dataOutputAssociations">
			<bpmn:dataOutputAssociation>
				<xsl:call-template name="DataOutputAssociationTemplate" />
			</bpmn:dataOutputAssociation>
		</xsl:for-each>


		<xsl:for-each
			select="resources[contains(@xmi:type, 'Performer') or contains(@xsi:type, 'Performer')]">
			<bpmn:performer>
				<xsl:call-template name="PerformerTemplate" />
			</bpmn:performer>
		</xsl:for-each>
		<xsl:for-each
			select="resources[contains(@xmi:type, 'HumanPerformer') or contains(@xsi:type, 'HumanPerformer')]">
			<bpmn:humanPerformer>
				<xsl:call-template name="HumanPerformerTemplate" />
			</bpmn:humanPerformer>
		</xsl:for-each>
		<xsl:for-each
			select="resources[contains(@xmi:type, 'PotentialOwner') or contains(@xsi:type, 'PotentialOwner')]">
			<bpmn:potentialOwner>
				<xsl:call-template name="PotentialOwnerTemplate" />
			</bpmn:potentialOwner>
		</xsl:for-each>


		<xsl:for-each
			select="loopCharacteristics[contains(@xmi:type, 'MultiInstanceLoopCharacteristics') or contains(@xsi:type, 'MultiInstanceLoopCharacteristics')]">
			<bpmn:multiInstanceLoopCharacteristics>
				<xsl:call-template name="MultiInstanceLoopCharacteristicsTemplate" />
			</bpmn:multiInstanceLoopCharacteristics>
		</xsl:for-each>
		<xsl:for-each
			select="loopCharacteristics[contains(@xmi:type, 'StandardLoopCharacteristics') or contains(@xsi:type, 'StandardLoopCharacteristics')]">
			<bpmn:standardLoopCharacteristics>
				<xsl:call-template name="StandardLoopCharacteristicsTemplate" />
			</bpmn:standardLoopCharacteristics>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="LoopCharacteristicsTemplate">
		<xsl:call-template name="BaseElementTemplate" />
	</xsl:template>

	<xsl:template name="BoundaryEventTemplate">
		<xsl:call-template name="CatchEventTemplate" />
		<xsl:if test="@cancelActivity">
			<xsl:attribute name="cancelActivity"> <xsl:value-of select="@cancelActivity" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@attachedToRef">
			<xsl:attribute name="attachedToRef"> <xsl:value-of select="@attachedToRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="CatchEventTemplate">
		<xsl:call-template name="EventTemplate" />
		<xsl:if test="@parallelMultiple">
			<xsl:attribute name="parallelMultiple"> <xsl:value-of select="@parallelMultiple" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="dataOutputs">
			<bpmn:dataOutput>
				<xsl:call-template name="DataOutputTemplate" />
			</bpmn:dataOutput>
		</xsl:for-each>


		<xsl:for-each select="dataOutputAssociation">
			<bpmn:dataOutputAssociation>
				<xsl:call-template name="DataOutputAssociationTemplate" />
			</bpmn:dataOutputAssociation>
		</xsl:for-each>


		<xsl:for-each select="outputSet">
			<bpmn:outputSet>
				<xsl:call-template name="OutputSetTemplate" />
			</bpmn:outputSet>
		</xsl:for-each>


		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'CancelEventDefinition') or contains(@xsi:type, 'CancelEventDefinition')]">
			<bpmn:cancelEventDefinition>
				<xsl:call-template name="CancelEventDefinitionTemplate" />
			</bpmn:cancelEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'CompensateEventDefinition') or contains(@xsi:type, 'CompensateEventDefinition')]">
			<bpmn:compensateEventDefinition>
				<xsl:call-template name="CompensateEventDefinitionTemplate" />
			</bpmn:compensateEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'ConditionalEventDefinition') or contains(@xsi:type, 'ConditionalEventDefinition')]">
			<bpmn:conditionalEventDefinition>
				<xsl:call-template name="ConditionalEventDefinitionTemplate" />
			</bpmn:conditionalEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'ErrorEventDefinition') or contains(@xsi:type, 'ErrorEventDefinition')]">
			<bpmn:errorEventDefinition>
				<xsl:call-template name="ErrorEventDefinitionTemplate" />
			</bpmn:errorEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'EscalationEventDefinition') or contains(@xsi:type, 'EscalationEventDefinition')]">
			<bpmn:escalationEventDefinition>
				<xsl:call-template name="EscalationEventDefinitionTemplate" />
			</bpmn:escalationEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'LinkEventDefinition') or contains(@xsi:type, 'LinkEventDefinition')]">
			<bpmn:linkEventDefinition>
				<xsl:call-template name="LinkEventDefinitionTemplate" />
			</bpmn:linkEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'MessageEventDefinition') or contains(@xsi:type, 'MessageEventDefinition')]">
			<bpmn:messageEventDefinition>
				<xsl:call-template name="MessageEventDefinitionTemplate" />
			</bpmn:messageEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'SignalEventDefinition') or contains(@xsi:type, 'SignalEventDefinition')]">
			<bpmn:signalEventDefinition>
				<xsl:call-template name="SignalEventDefinitionTemplate" />
			</bpmn:signalEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'TerminateEventDefinition') or contains(@xsi:type, 'TerminateEventDefinition')]">
			<bpmn:terminateEventDefinition>
				<xsl:call-template name="TerminateEventDefinitionTemplate" />
			</bpmn:terminateEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'TimerEventDefinition') or contains(@xsi:type, 'TimerEventDefinition')]">
			<bpmn:timerEventDefinition>
				<xsl:call-template name="TimerEventDefinitionTemplate" />
			</bpmn:timerEventDefinition>
		</xsl:for-each>


		<xsl:if test="@eventDefinitionRefs">
			<xsl:attribute name="eventDefinitionRefs"> <xsl:value-of
				select="@eventDefinitionRefs" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="EventTemplate">
		<xsl:call-template name="FlowNodeTemplate" />
		<xsl:call-template name="InteractionNodeTemplate" />

		<xsl:for-each select="properties">
			<bpmn:property>
				<xsl:call-template name="PropertyTemplate" />
			</bpmn:property>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="EventDefinitionTemplate">
		<xsl:call-template name="RootElementTemplate" />
	</xsl:template>

	<xsl:template name="DataOutputAssociationTemplate">
		<xsl:call-template name="DataAssociationTemplate" />
	</xsl:template>

	<xsl:template name="DataAssociationTemplate">
		<xsl:call-template name="BaseElementTemplate" />

		<xsl:if test="@sourceRef">
			<xsl:attribute name="sourceRef"> <xsl:value-of select="@sourceRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@targetRef">
			<xsl:attribute name="targetRef"> <xsl:value-of select="@targetRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="transformation">
			<bpmn:transformation>
				<xsl:call-template name="FormalExpressionTemplate" />
			</bpmn:transformation>
		</xsl:for-each>


		<xsl:for-each select="assignment">
			<bpmn:assignment>
				<xsl:call-template name="AssignmentTemplate" />
			</bpmn:assignment>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="AssignmentTemplate">
		<xsl:call-template name="BaseElementTemplate" />

		<xsl:for-each select="from">
			<bpmn:from>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:from>
		</xsl:for-each>


		<xsl:for-each select="to">
			<bpmn:to>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:to>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="DataInputAssociationTemplate">
		<xsl:call-template name="DataAssociationTemplate" />
	</xsl:template>

	<xsl:template name="UserTaskTemplate">
		<xsl:call-template name="TaskTemplate" />
		<xsl:if test="@implementation">
			<xsl:attribute name="implementation"> <xsl:value-of select="@implementation" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="renderings">
			<bpmn:rendering>
				<xsl:call-template name="RenderingTemplate" />
			</bpmn:rendering>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="RenderingTemplate">
		<xsl:call-template name="BaseElementTemplate" />
	</xsl:template>

	<xsl:template name="HumanPerformerTemplate">
		<xsl:call-template name="PerformerTemplate" />
	</xsl:template>

	<xsl:template name="PotentialOwnerTemplate">
		<xsl:call-template name="HumanPerformerTemplate" />
	</xsl:template>

	<xsl:template name="GlobalUserTaskTemplate">
		<xsl:call-template name="GlobalTaskTemplate" />
		<xsl:if test="@implementation">
			<xsl:attribute name="implementation"> <xsl:value-of select="@implementation" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="renderings">
			<bpmn:rendering>
				<xsl:call-template name="RenderingTemplate" />
			</bpmn:rendering>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="GatewayTemplate">
		<xsl:call-template name="FlowNodeTemplate" />
		<xsl:if test="@gatewayDirection">
			<xsl:attribute name="gatewayDirection"> <xsl:value-of select="@gatewayDirection" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="EventBasedGatewayTemplate">
		<xsl:call-template name="GatewayTemplate" />
		<xsl:if test="@instantiate">
			<xsl:attribute name="instantiate"> <xsl:value-of select="@instantiate" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@eventGatewayType">
			<xsl:attribute name="eventGatewayType"> <xsl:value-of select="@eventGatewayType" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ComplexGatewayTemplate">
		<xsl:call-template name="GatewayTemplate" />
		<xsl:if test="@default">
			<xsl:attribute name="default"> <xsl:value-of select="@default" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="activationCondition">
			<bpmn:activationCondition>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:activationCondition>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ExclusiveGatewayTemplate">
		<xsl:call-template name="GatewayTemplate" />
		<xsl:if test="@default">
			<xsl:attribute name="default"> <xsl:value-of select="@default" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="InclusiveGatewayTemplate">
		<xsl:call-template name="GatewayTemplate" />
		<xsl:if test="@default">
			<xsl:attribute name="default"> <xsl:value-of select="@default" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ParallelGatewayTemplate">
		<xsl:call-template name="GatewayTemplate" />
	</xsl:template>

	<xsl:template name="RelationshipTemplate">
		<xsl:call-template name="BaseElementTemplate" />
		<xsl:if test="@type">
			<xsl:attribute name="type"> <xsl:value-of select="@type" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@direction">
			<xsl:attribute name="direction"> <xsl:value-of select="@direction" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@sources">
			<xsl:attribute name="sources"> <xsl:value-of select="@sources" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@targets">
			<xsl:attribute name="targets"> <xsl:value-of select="@targets" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ExtensionTemplate">
		<xsl:if test="@mustUnderstand">
			<xsl:attribute name="mustUnderstand"> <xsl:value-of select="@mustUnderstand" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="definition">
			<xsl:attribute name="definition"> <xsl:value-of select="definition" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="IntermediateCatchEventTemplate">
		<xsl:call-template name="CatchEventTemplate" />
	</xsl:template>

	<xsl:template name="IntermediateThrowEventTemplate">
		<xsl:call-template name="ThrowEventTemplate" />
	</xsl:template>

	<xsl:template name="ThrowEventTemplate">
		<xsl:call-template name="EventTemplate" />

		<xsl:for-each select="dataInputs">
			<bpmn:dataInput>
				<xsl:call-template name="DataInputTemplate" />
			</bpmn:dataInput>
		</xsl:for-each>


		<xsl:for-each select="dataInputAssociation">
			<bpmn:dataInputAssociation>
				<xsl:call-template name="DataInputAssociationTemplate" />
			</bpmn:dataInputAssociation>
		</xsl:for-each>


		<xsl:for-each select="inputSet">
			<bpmn:inputSet>
				<xsl:call-template name="InputSetTemplate" />
			</bpmn:inputSet>
		</xsl:for-each>


		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'CancelEventDefinition') or contains(@xsi:type, 'CancelEventDefinition')]">
			<bpmn:cancelEventDefinition>
				<xsl:call-template name="CancelEventDefinitionTemplate" />
			</bpmn:cancelEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'CompensateEventDefinition') or contains(@xsi:type, 'CompensateEventDefinition')]">
			<bpmn:compensateEventDefinition>
				<xsl:call-template name="CompensateEventDefinitionTemplate" />
			</bpmn:compensateEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'ConditionalEventDefinition') or contains(@xsi:type, 'ConditionalEventDefinition')]">
			<bpmn:conditionalEventDefinition>
				<xsl:call-template name="ConditionalEventDefinitionTemplate" />
			</bpmn:conditionalEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'ErrorEventDefinition') or contains(@xsi:type, 'ErrorEventDefinition')]">
			<bpmn:errorEventDefinition>
				<xsl:call-template name="ErrorEventDefinitionTemplate" />
			</bpmn:errorEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'EscalationEventDefinition') or contains(@xsi:type, 'EscalationEventDefinition')]">
			<bpmn:escalationEventDefinition>
				<xsl:call-template name="EscalationEventDefinitionTemplate" />
			</bpmn:escalationEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'LinkEventDefinition') or contains(@xsi:type, 'LinkEventDefinition')]">
			<bpmn:linkEventDefinition>
				<xsl:call-template name="LinkEventDefinitionTemplate" />
			</bpmn:linkEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'MessageEventDefinition') or contains(@xsi:type, 'MessageEventDefinition')]">
			<bpmn:messageEventDefinition>
				<xsl:call-template name="MessageEventDefinitionTemplate" />
			</bpmn:messageEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'SignalEventDefinition') or contains(@xsi:type, 'SignalEventDefinition')]">
			<bpmn:signalEventDefinition>
				<xsl:call-template name="SignalEventDefinitionTemplate" />
			</bpmn:signalEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'TerminateEventDefinition') or contains(@xsi:type, 'TerminateEventDefinition')]">
			<bpmn:terminateEventDefinition>
				<xsl:call-template name="TerminateEventDefinitionTemplate" />
			</bpmn:terminateEventDefinition>
		</xsl:for-each>
		<xsl:for-each
			select="eventDefinitions[contains(@xmi:type, 'TimerEventDefinition') or contains(@xsi:type, 'TimerEventDefinition')]">
			<bpmn:timerEventDefinition>
				<xsl:call-template name="TimerEventDefinitionTemplate" />
			</bpmn:timerEventDefinition>
		</xsl:for-each>


		<xsl:if test="@eventDefinitionRefs">
			<xsl:attribute name="eventDefinitionRefs"> <xsl:value-of
				select="@eventDefinitionRefs" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="EndEventTemplate">
		<xsl:call-template name="ThrowEventTemplate" />
	</xsl:template>

	<xsl:template name="StartEventTemplate">
		<xsl:call-template name="CatchEventTemplate" />
		<xsl:if test="@isInterrupting">
			<xsl:attribute name="isInterrupting"> <xsl:value-of select="@isInterrupting" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="CancelEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />
	</xsl:template>

	<xsl:template name="ErrorEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />
		<xsl:if test="@errorRef">
			<xsl:attribute name="errorRef"> <xsl:value-of select="@errorRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="TerminateEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />
	</xsl:template>

	<xsl:template name="EscalationEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />
		<xsl:if test="@escalationRef">
			<xsl:attribute name="escalationRef"> <xsl:value-of select="@escalationRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="EscalationTemplate">
		<xsl:if test="@structureRef">
			<xsl:attribute name="structureRef"> <xsl:value-of select="@structureRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@escalationCode">
			<xsl:attribute name="escalationCode"> <xsl:value-of select="@escalationCode" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="CompensateEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />
		<xsl:if test="@waitForCompletion">
			<xsl:attribute name="waitForCompletion"> <xsl:value-of select="@waitForCompletion" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@activityRef">
			<xsl:attribute name="activityRef"> <xsl:value-of select="@activityRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="TimerEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />

		<xsl:for-each select="timeDate">
			<bpmn:timeDate>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:timeDate>
		</xsl:for-each>


		<xsl:for-each select="timeDuration">
			<bpmn:timeDuration>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:timeDuration>
		</xsl:for-each>


		<xsl:for-each select="timeCycle">
			<bpmn:timeCycle>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:timeCycle>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="LinkEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@source">
			<xsl:attribute name="source"> <xsl:value-of select="@source" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@target">
			<xsl:attribute name="target"> <xsl:value-of select="@target" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="MessageEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />
		<xsl:if test="@messageRef">
			<xsl:attribute name="messageRef"> <xsl:value-of select="@messageRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@operationRef">
			<xsl:attribute name="operationRef"> <xsl:value-of select="@operationRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ConditionalEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />

		<xsl:for-each select="condition">
			<bpmn:condition>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:condition>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="SignalEventDefinitionTemplate">
		<xsl:call-template name="EventDefinitionTemplate" />
		<xsl:if test="@signalRef">
			<xsl:attribute name="signalRef"> <xsl:value-of select="@signalRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="SignalTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@structureRef">
			<xsl:attribute name="structureRef"> <xsl:value-of select="@structureRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ImplicitThrowEventTemplate">
		<xsl:call-template name="ThrowEventTemplate" />
	</xsl:template>

	<xsl:template name="DataObjectTemplate">
		<xsl:call-template name="FlowElementTemplate" />
		<xsl:call-template name="ItemAwareElementTemplate" />
		<xsl:if test="@isCollection">
			<xsl:attribute name="isCollection"> <xsl:value-of select="@isCollection" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="DataStoreTemplate">
		<xsl:call-template name="ItemAwareElementTemplate" />
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@capacity">
			<xsl:attribute name="capacity"> <xsl:value-of select="@capacity" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isUnlimited">
			<xsl:attribute name="isUnlimited"> <xsl:value-of select="@isUnlimited" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="DataStoreReferenceTemplate">
		<xsl:call-template name="FlowElementTemplate" />
		<xsl:call-template name="ItemAwareElementTemplate" />
		<xsl:if test="@dataStoreRef">
			<xsl:attribute name="dataStoreRef"> <xsl:value-of select="@dataStoreRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="DataObjectReferenceTemplate">
		<xsl:call-template name="FlowElementTemplate" />
		<xsl:call-template name="ItemAwareElementTemplate" />
		<xsl:if test="@dataObjectRef">
			<xsl:attribute name="dataObjectRef"> <xsl:value-of select="@dataObjectRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="CallConversationTemplate">
		<xsl:call-template name="ConversationNodeTemplate" />
		<xsl:if test="@calledCollaborationRef">
			<xsl:attribute name="calledCollaborationRef"> <xsl:value-of
				select="@calledCollaborationRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="participantAssociations">
			<bpmn:participantAssociation>
				<xsl:call-template name="ParticipantAssociationTemplate" />
			</bpmn:participantAssociation>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ConversationTemplate">
		<xsl:call-template name="ConversationNodeTemplate" />
	</xsl:template>

	<xsl:template name="SubConversationTemplate">
		<xsl:call-template name="ConversationNodeTemplate" />

		<xsl:for-each
			select="conversationNodes[contains(@xmi:type, 'CallConversation') or contains(@xsi:type, 'CallConversation')]">
			<bpmn:callConversation>
				<xsl:call-template name="CallConversationTemplate" />
			</bpmn:callConversation>
		</xsl:for-each>
		<xsl:for-each
			select="conversationNodes[contains(@xmi:type, 'Conversation') or contains(@xsi:type, 'Conversation')]">
			<bpmn:conversation>
				<xsl:call-template name="ConversationTemplate" />
			</bpmn:conversation>
		</xsl:for-each>
		<xsl:for-each
			select="conversationNodes[contains(@xmi:type, 'SubConversation') or contains(@xsi:type, 'SubConversation')]">
			<bpmn:subConversation>
				<xsl:call-template name="SubConversationTemplate" />
			</bpmn:subConversation>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="GlobalConversationTemplate">
		<xsl:call-template name="CollaborationTemplate" />
	</xsl:template>

	<xsl:template name="PartnerEntityTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@participantRef">
			<xsl:attribute name="participantRef"> <xsl:value-of select="@participantRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="PartnerRoleTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@participantRef">
			<xsl:attribute name="participantRef"> <xsl:value-of select="@participantRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ChoreographyActivityTemplate">
		<xsl:call-template name="FlowNodeTemplate" />
		<xsl:if test="@initiatingParticipantRef">
			<xsl:attribute name="initiatingParticipantRef"> <xsl:value-of
				select="@initiatingParticipantRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@loopType">
			<xsl:attribute name="loopType"> <xsl:value-of select="@loopType" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@participantRefs">
			<xsl:attribute name="participantRefs"> <xsl:value-of select="@participantRefs" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="correlationKeys">
			<bpmn:correlationKey>
				<xsl:call-template name="CorrelationKeyTemplate" />
			</bpmn:correlationKey>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="CallChoreographyTemplate">
		<xsl:call-template name="ChoreographyActivityTemplate" />
		<xsl:if test="@calledChoreographyRef">
			<xsl:attribute name="calledChoreographyRef"> <xsl:value-of
				select="@calledChoreographyRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="participantAssociations">
			<bpmn:participantAssociation>
				<xsl:call-template name="ParticipantAssociationTemplate" />
			</bpmn:participantAssociation>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="SubChoreographyTemplate">
		<xsl:call-template name="ChoreographyActivityTemplate" />
		<xsl:call-template name="FlowElementsContainerTemplate" />

		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'Association') or contains(@xsi:type, 'Association')]">
			<bpmn:association>
				<xsl:call-template name="AssociationTemplate" />
			</bpmn:association>
		</xsl:for-each>
		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'Group') or contains(@xsi:type, 'Group')]">
			<bpmn:group>
				<xsl:call-template name="GroupTemplate" />
			</bpmn:group>
		</xsl:for-each>
		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'TextAnnotation') or contains(@xsi:type, 'TextAnnotation')]">
			<bpmn:textAnnotation>
				<xsl:call-template name="TextAnnotationTemplate" />
			</bpmn:textAnnotation>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ChoreographyTaskTemplate">
		<xsl:call-template name="ChoreographyActivityTemplate" />

		<xsl:if test="@messageFlowRef">
			<xsl:attribute name="messageFlowRef"> <xsl:value-of select="@messageFlowRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="GlobalChoreographyTaskTemplate">
		<xsl:call-template name="ChoreographyTemplate" />
		<xsl:if test="@initiatingParticipantRef">
			<xsl:attribute name="initiatingParticipantRef"> <xsl:value-of
				select="@initiatingParticipantRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="TextAnnotationTemplate">
		<xsl:call-template name="ArtifactTemplate" />
		<xsl:if test="@textFormat">
			<xsl:attribute name="textFormat"> <xsl:value-of select="@textFormat" /> </xsl:attribute>
		</xsl:if>

		<bpmn:text>
			<xsl:value-of select="@text" />
		</bpmn:text>
	</xsl:template>

	<xsl:template name="GroupTemplate">
		<xsl:call-template name="ArtifactTemplate" />
		<xsl:if test="@categoryValueRef">
			<xsl:attribute name="categoryValueRef"> <xsl:value-of select="@categoryValueRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="AssociationTemplate">
		<xsl:call-template name="ArtifactTemplate" />
		<xsl:if test="@associationDirection">
			<xsl:attribute name="associationDirection"> <xsl:value-of
				select="@associationDirection" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@sourceRef">
			<xsl:attribute name="sourceRef"> <xsl:value-of select="@sourceRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@targetRef">
			<xsl:attribute name="targetRef"> <xsl:value-of select="@targetRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="CategoryTemplate">
		<xsl:call-template name="RootElementTemplate" />
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="categoryValue">
			<bpmn:categoryValue>
				<xsl:call-template name="CategoryValueTemplate" />
			</bpmn:categoryValue>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ServiceTaskTemplate">
		<xsl:call-template name="TaskTemplate" />
		<xsl:if test="@implementation">
			<xsl:attribute name="implementation"> <xsl:value-of select="@implementation" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@operationRef">
			<xsl:attribute name="operationRef"> <xsl:value-of select="@operationRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="SubProcessTemplate">
		<xsl:call-template name="ActivityTemplate" />
		<xsl:call-template name="FlowElementsContainerTemplate" />
		<xsl:if test="@triggeredByEvent">
			<xsl:attribute name="triggeredByEvent"> <xsl:value-of select="@triggeredByEvent" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'Association') or contains(@xsi:type, 'Association')]">
			<bpmn:association>
				<xsl:call-template name="AssociationTemplate" />
			</bpmn:association>
		</xsl:for-each>
		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'Group') or contains(@xsi:type, 'Group')]">
			<bpmn:group>
				<xsl:call-template name="GroupTemplate" />
			</bpmn:group>
		</xsl:for-each>
		<xsl:for-each
			select="artifacts[contains(@xmi:type, 'TextAnnotation') or contains(@xsi:type, 'TextAnnotation')]">
			<bpmn:textAnnotation>
				<xsl:call-template name="TextAnnotationTemplate" />
			</bpmn:textAnnotation>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="MultiInstanceLoopCharacteristicsTemplate">
		<xsl:call-template name="LoopCharacteristicsTemplate" />
		<xsl:if test="@isSequential">
			<xsl:attribute name="isSequential"> <xsl:value-of select="@isSequential" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@behavior">
			<xsl:attribute name="behavior"> <xsl:value-of select="@behavior" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@oneBehaviorEventRef">
			<xsl:attribute name="oneBehaviorEventRef"> <xsl:value-of
				select="@oneBehaviorEventRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@noneBehaviorEventRef">
			<xsl:attribute name="noneBehaviorEventRef"> <xsl:value-of
				select="@noneBehaviorEventRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="loopCardinality">
			<bpmn:loopCardinality>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:loopCardinality>
		</xsl:for-each>


		<xsl:if test="@loopDataInputRef">
			<xsl:attribute name="loopDataInputRef"> <xsl:value-of select="@loopDataInputRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@loopDataOutputRef">
			<xsl:attribute name="loopDataOutputRef"> <xsl:value-of select="@loopDataOutputRef" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="inputDataItem">
			<bpmn:inputDataItem>
				<xsl:call-template name="DataInputTemplate" />
			</bpmn:inputDataItem>
		</xsl:for-each>


		<xsl:for-each select="outputDataItem">
			<bpmn:outputDataItem>
				<xsl:call-template name="DataOutputTemplate" />
			</bpmn:outputDataItem>
		</xsl:for-each>


		<xsl:for-each select="complexBehaviorDefinition">
			<bpmn:complexBehaviorDefinition>
				<xsl:call-template name="ComplexBehaviorDefinitionTemplate" />
			</bpmn:complexBehaviorDefinition>
		</xsl:for-each>


		<xsl:for-each select="completionCondition">
			<bpmn:completionCondition>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:completionCondition>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ComplexBehaviorDefinitionTemplate">
		<xsl:call-template name="BaseElementTemplate" />

		<xsl:for-each select="condition">
			<bpmn:condition>
				<xsl:call-template name="FormalExpressionTemplate" />
			</bpmn:condition>
		</xsl:for-each>


		<xsl:for-each select="event">
			<bpmn:event>
				<xsl:call-template name="ImplicitThrowEventTemplate" />
			</bpmn:event>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="StandardLoopCharacteristicsTemplate">
		<xsl:call-template name="LoopCharacteristicsTemplate" />
		<xsl:if test="@testBefore">
			<xsl:attribute name="testBefore"> <xsl:value-of select="@testBefore" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="loopMaximum">
			<xsl:attribute name="loopMaximum"> <xsl:value-of select="loopMaximum" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="loopCondition">
			<bpmn:loopCondition>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:loopCondition>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="CallActivityTemplate">
		<xsl:call-template name="ActivityTemplate" />
		<xsl:if test="@calledElementRef">
			<xsl:attribute name="calledElementRef"> <xsl:value-of select="@calledElementRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="SendTaskTemplate">
		<xsl:call-template name="TaskTemplate" />
		<xsl:if test="@implementation">
			<xsl:attribute name="implementation"> <xsl:value-of select="@implementation" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@operationRef">
			<xsl:attribute name="operationRef"> <xsl:value-of select="@operationRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@messageRef">
			<xsl:attribute name="messageRef"> <xsl:value-of select="@messageRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ReceiveTaskTemplate">
		<xsl:call-template name="TaskTemplate" />
		<xsl:if test="@implementation">
			<xsl:attribute name="implementation"> <xsl:value-of select="@implementation" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@instantiate">
			<xsl:attribute name="instantiate"> <xsl:value-of select="@instantiate" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@operationRef">
			<xsl:attribute name="operationRef"> <xsl:value-of select="@operationRef" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@messageRef">
			<xsl:attribute name="messageRef"> <xsl:value-of select="@messageRef" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="ScriptTaskTemplate">
		<xsl:call-template name="TaskTemplate" />
		<xsl:if test="@scriptFormat">
			<xsl:attribute name="scriptFormat"> <xsl:value-of select="@scriptFormat" /> </xsl:attribute>
		</xsl:if>

		<bpmn:script>
			<xsl:value-of select="@script" />
		</bpmn:script>
	</xsl:template>

	<xsl:template name="BusinessRuleTaskTemplate">
		<xsl:call-template name="TaskTemplate" />
		<xsl:if test="@implementation">
			<xsl:attribute name="implementation"> <xsl:value-of select="@implementation" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="AdHocSubProcessTemplate">
		<xsl:call-template name="SubProcessTemplate" />
		<xsl:if test="@ordering">
			<xsl:attribute name="ordering"> <xsl:value-of select="@ordering" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@cancelRemainingInstances">
			<xsl:attribute name="cancelRemainingInstances"> <xsl:value-of
				select="@cancelRemainingInstances" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="completionCondition">
			<bpmn:completionCondition>
				<xsl:call-template name="ExpressionTemplate" />
			</bpmn:completionCondition>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="TransactionTemplate">
		<xsl:call-template name="SubProcessTemplate" />
		<xsl:if test="@method">
			<xsl:attribute name="method"> <xsl:value-of select="@method" /> </xsl:attribute>
		</xsl:if>

		<bpmn:protocol>
			<xsl:value-of select="@protocol" />
		</bpmn:protocol>
	</xsl:template>

	<xsl:template name="GlobalScriptTaskTemplate">
		<xsl:call-template name="GlobalTaskTemplate" />
		<xsl:if test="@scriptLanguage">
			<xsl:attribute name="scriptLanguage"> <xsl:value-of select="@scriptLanguage" /> </xsl:attribute>
		</xsl:if>

		<bpmn:script>
			<xsl:value-of select="@script" />
		</bpmn:script>
	</xsl:template>

	<xsl:template name="GlobalBusinessRuleTaskTemplate">
		<xsl:call-template name="GlobalTaskTemplate" />
		<xsl:if test="@implementation">
			<xsl:attribute name="implementation"> <xsl:value-of select="@implementation" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="DefinitionsTemplate" match="//bpmnxmi:Definitions">
		<bpmn:definitions>
			<xsl:call-template name="BaseElementTemplate" />
			<xsl:if test="@name">
				<xsl:attribute name="name"> <xsl:value-of
					select="@name" /> </xsl:attribute>
			</xsl:if>
			<xsl:if test="@targetNamespace">
				<xsl:attribute name="targetNamespace"> <xsl:value-of
					select="@targetNamespace" /> </xsl:attribute>
			</xsl:if>
			<xsl:if test="@expressionLanguage">
				<xsl:attribute name="expressionLanguage"> <xsl:value-of
					select="@expressionLanguage" /> </xsl:attribute>
			</xsl:if>
			<xsl:if test="@typeLanguage">
				<xsl:attribute name="typeLanguage"> <xsl:value-of
					select="@typeLanguage" /> </xsl:attribute>
			</xsl:if>
			<xsl:if test="@exporter">
				<xsl:attribute name="exporter"> <xsl:value-of
					select="@exporter" /> </xsl:attribute>
			</xsl:if>
			<xsl:if test="@exporterVersion">
				<xsl:attribute name="exporterVersion"> <xsl:value-of
					select="@exporterVersion" /> </xsl:attribute>
			</xsl:if>

			<xsl:for-each select="imports">
				<bpmn:import>
					<xsl:call-template name="ImportTemplate" />
				</bpmn:import>
			</xsl:for-each>


			<xsl:for-each select="extensions">
				<bpmn:extension>
					<xsl:call-template name="ExtensionTemplate" />
				</bpmn:extension>
			</xsl:for-each>


			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'EventDefinition') or contains(@xsi:type, 'EventDefinition')]">
				<bpmn:eventDefinition>
					<xsl:call-template name="EventDefinitionTemplate" />
				</bpmn:eventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Category') or contains(@xsi:type, 'Category')]">
				<bpmn:category>
					<xsl:call-template name="CategoryTemplate" />
				</bpmn:category>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Collaboration') or contains(@xsi:type, 'Collaboration')]">
				<bpmn:collaboration>
					<xsl:call-template name="CollaborationTemplate" />
				</bpmn:collaboration>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'CorrelationProperty') or contains(@xsi:type, 'CorrelationProperty')]">
				<bpmn:correlationProperty>
					<xsl:call-template name="CorrelationPropertyTemplate" />
				</bpmn:correlationProperty>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'DataStore') or contains(@xsi:type, 'DataStore')]">
				<bpmn:dataStore>
					<xsl:call-template name="DataStoreTemplate" />
				</bpmn:dataStore>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'EndPoint') or contains(@xsi:type, 'EndPoint')]">
				<bpmn:endPoint>
					<xsl:call-template name="EndPointTemplate" />
				</bpmn:endPoint>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Error') or contains(@xsi:type, 'Error')]">
				<bpmn:error>
					<xsl:call-template name="ErrorTemplate" />
				</bpmn:error>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Escalation') or contains(@xsi:type, 'Escalation')]">
				<bpmn:escalation>
					<xsl:call-template name="EscalationTemplate" />
				</bpmn:escalation>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'GlobalBusinessRuleTask') or contains(@xsi:type, 'GlobalBusinessRuleTask')]">
				<bpmn:globalBusinessRuleTask>
					<xsl:call-template name="GlobalBusinessRuleTaskTemplate" />
				</bpmn:globalBusinessRuleTask>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'GlobalManualTask') or contains(@xsi:type, 'GlobalManualTask')]">
				<bpmn:globalManualTask>
					<xsl:call-template name="GlobalManualTaskTemplate" />
				</bpmn:globalManualTask>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'GlobalScriptTask') or contains(@xsi:type, 'GlobalScriptTask')]">
				<bpmn:globalScriptTask>
					<xsl:call-template name="GlobalScriptTaskTemplate" />
				</bpmn:globalScriptTask>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'GlobalTask') or contains(@xsi:type, 'GlobalTask')]">
				<bpmn:globalTask>
					<xsl:call-template name="GlobalTaskTemplate" />
				</bpmn:globalTask>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'GlobalUserTask') or contains(@xsi:type, 'GlobalUserTask')]">
				<bpmn:globalUserTask>
					<xsl:call-template name="GlobalUserTaskTemplate" />
				</bpmn:globalUserTask>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Interface') or contains(@xsi:type, 'Interface')]">
				<bpmn:interface>
					<xsl:call-template name="InterfaceTemplate" />
				</bpmn:interface>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'ItemDefinition') or contains(@xsi:type, 'ItemDefinition')]">
				<bpmn:itemDefinition>
					<xsl:call-template name="ItemDefinitionTemplate" />
				</bpmn:itemDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Message') or contains(@xsi:type, 'Message')]">
				<bpmn:message>
					<xsl:call-template name="MessageTemplate" />
				</bpmn:message>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'PartnerEntity') or contains(@xsi:type, 'PartnerEntity')]">
				<bpmn:partnerEntity>
					<xsl:call-template name="PartnerEntityTemplate" />
				</bpmn:partnerEntity>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'PartnerRole') or contains(@xsi:type, 'PartnerRole')]">
				<bpmn:partnerRole>
					<xsl:call-template name="PartnerRoleTemplate" />
				</bpmn:partnerRole>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Process') or contains(@xsi:type, 'Process')]">
				<bpmn:process>
					<xsl:call-template name="ProcessTemplate" />
				</bpmn:process>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Resource') or contains(@xsi:type, 'Resource')]">
				<bpmn:resource>
					<xsl:call-template name="ResourceTemplate" />
				</bpmn:resource>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Signal') or contains(@xsi:type, 'Signal')]">
				<bpmn:signal>
					<xsl:call-template name="SignalTemplate" />
				</bpmn:signal>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'CancelEventDefinition') or contains(@xsi:type, 'CancelEventDefinition')]">
				<bpmn:cancelEventDefinition>
					<xsl:call-template name="CancelEventDefinitionTemplate" />
				</bpmn:cancelEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'CompensateEventDefinition') or contains(@xsi:type, 'CompensateEventDefinition')]">
				<bpmn:compensateEventDefinition>
					<xsl:call-template name="CompensateEventDefinitionTemplate" />
				</bpmn:compensateEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'ConditionalEventDefinition') or contains(@xsi:type, 'ConditionalEventDefinition')]">
				<bpmn:conditionalEventDefinition>
					<xsl:call-template name="ConditionalEventDefinitionTemplate" />
				</bpmn:conditionalEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'ErrorEventDefinition') or contains(@xsi:type, 'ErrorEventDefinition')]">
				<bpmn:errorEventDefinition>
					<xsl:call-template name="ErrorEventDefinitionTemplate" />
				</bpmn:errorEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'EscalationEventDefinition') or contains(@xsi:type, 'EscalationEventDefinition')]">
				<bpmn:escalationEventDefinition>
					<xsl:call-template name="EscalationEventDefinitionTemplate" />
				</bpmn:escalationEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'LinkEventDefinition') or contains(@xsi:type, 'LinkEventDefinition')]">
				<bpmn:linkEventDefinition>
					<xsl:call-template name="LinkEventDefinitionTemplate" />
				</bpmn:linkEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'MessageEventDefinition') or contains(@xsi:type, 'MessageEventDefinition')]">
				<bpmn:messageEventDefinition>
					<xsl:call-template name="MessageEventDefinitionTemplate" />
				</bpmn:messageEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'SignalEventDefinition') or contains(@xsi:type, 'SignalEventDefinition')]">
				<bpmn:signalEventDefinition>
					<xsl:call-template name="SignalEventDefinitionTemplate" />
				</bpmn:signalEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'TerminateEventDefinition') or contains(@xsi:type, 'TerminateEventDefinition')]">
				<bpmn:terminateEventDefinition>
					<xsl:call-template name="TerminateEventDefinitionTemplate" />
				</bpmn:terminateEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'TimerEventDefinition') or contains(@xsi:type, 'TimerEventDefinition')]">
				<bpmn:timerEventDefinition>
					<xsl:call-template name="TimerEventDefinitionTemplate" />
				</bpmn:timerEventDefinition>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'Choreography') or contains(@xsi:type, 'Choreography')]">
				<bpmn:choreography>
					<xsl:call-template name="ChoreographyTemplate" />
				</bpmn:choreography>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'GlobalConversation') or contains(@xsi:type, 'GlobalConversation')]">
				<bpmn:globalConversation>
					<xsl:call-template name="GlobalConversationTemplate" />
				</bpmn:globalConversation>
			</xsl:for-each>
			<xsl:for-each
				select="rootElements[contains(@xmi:type, 'GlobalChoreographyTask') or contains(@xsi:type, 'GlobalChoreographyTask')]">
				<bpmn:globalChoreographyTask>
					<xsl:call-template name="GlobalChoreographyTaskTemplate" />
				</bpmn:globalChoreographyTask>
			</xsl:for-each>


			<xsl:for-each select="diagrams">
				<bpmndi:BPMNDiagram>
					<xsl:call-template name="BPMNDiagramTemplate" />
				</bpmndi:BPMNDiagram>
			</xsl:for-each>


			<xsl:for-each select="relationships">
				<bpmn:relationship>
					<xsl:call-template name="RelationshipTemplate" />
				</bpmn:relationship>
			</xsl:for-each>
		</bpmn:definitions>
	</xsl:template>

	<xsl:template name="BPMNPlaneTemplate">
		<xsl:call-template name="PlaneTemplate" />
		<xsl:if test="@bpmnElement">
			<xsl:attribute name="bpmnElement"> <xsl:value-of select="@bpmnElement" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="BPMNShapeTemplate">
		<xsl:call-template name="LabeledShapeTemplate" />
		<xsl:if test="@bpmnElement">
			<xsl:attribute name="bpmnElement"> <xsl:value-of select="@bpmnElement" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isHorizontal">
			<xsl:attribute name="isHorizontal"> <xsl:value-of select="@isHorizontal" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isExpanded">
			<xsl:attribute name="isExpanded"> <xsl:value-of select="@isExpanded" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isMarkerVisible">
			<xsl:attribute name="isMarkerVisible"> <xsl:value-of select="@isMarkerVisible" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isMessageVisible">
			<xsl:attribute name="isMessageVisible"> <xsl:value-of select="@isMessageVisible" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@participantBandKind">
			<xsl:attribute name="participantBandKind"> <xsl:value-of
				select="@participantBandKind" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@choreographyActivityShape">
			<xsl:attribute name="choreographyActivityShape"> <xsl:value-of
				select="@choreographyActivityShape" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="label">
			<bpmndi:BPMNLabel>
				<xsl:call-template name="BPMNLabelTemplate" />
			</bpmndi:BPMNLabel>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="BPMNLabelTemplate">
		<xsl:call-template name="LabelTemplate" />
		<xsl:if test="@labelStyle">
			<xsl:attribute name="labelStyle"> <xsl:value-of select="@labelStyle" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="BPMNLabelStyleTemplate">
		<xsl:call-template name="StyleTemplate" />

		<xsl:for-each select="font">
			<dc:Font>
				<xsl:call-template name="FontTemplate" />
			</dc:Font>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="BPMNEdgeTemplate">
		<xsl:call-template name="LabeledEdgeTemplate" />
		<xsl:if test="@bpmnElement">
			<xsl:attribute name="bpmnElement"> <xsl:value-of select="@bpmnElement" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@sourceElement">
			<xsl:attribute name="sourceElement"> <xsl:value-of select="@sourceElement" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@targetElement">
			<xsl:attribute name="targetElement"> <xsl:value-of select="@targetElement" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@messageVisibleKind">
			<xsl:attribute name="messageVisibleKind"> <xsl:value-of
				select="@messageVisibleKind" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="label">
			<bpmndi:BPMNLabel>
				<xsl:call-template name="BPMNLabelTemplate" />
			</bpmndi:BPMNLabel>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="BPMNDiagramTemplate">
		<xsl:call-template name="DiagramTemplate" />

		<xsl:for-each select="plane">
			<bpmndi:BPMNPlane>
				<xsl:call-template name="BPMNPlaneTemplate" />
			</bpmndi:BPMNPlane>
		</xsl:for-each>


		<xsl:for-each select="labelStyle">
			<bpmndi:BPMNLabelStyle>
				<xsl:call-template name="BPMNLabelStyleTemplate" />
			</bpmndi:BPMNLabelStyle>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="DiagramElementTemplate">

		<xsl:if test="@owningDiagram">
			<xsl:attribute name="owningDiagram"> <xsl:value-of select="@owningDiagram" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@owningElement">
			<xsl:attribute name="owningElement"> <xsl:value-of select="@owningElement" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@ownedElement">
			<xsl:attribute name="ownedElement"> <xsl:value-of select="@ownedElement" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@modelElement">
			<xsl:attribute name="modelElement"> <xsl:value-of select="@modelElement" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@style">
			<xsl:attribute name="style"> <xsl:value-of select="@style" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="DiagramTemplate">
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@documentation">
			<xsl:attribute name="documentation"> <xsl:value-of select="@documentation" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@resolution">
			<xsl:attribute name="resolution"> <xsl:value-of select="@resolution" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@ownedStyle">
			<xsl:attribute name="ownedStyle"> <xsl:value-of select="@ownedStyle" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@rootElement">
			<xsl:attribute name="rootElement"> <xsl:value-of select="@rootElement" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="StyleTemplate">
	</xsl:template>

	<xsl:template name="NodeTemplate">
		<xsl:call-template name="DiagramElementTemplate" />
	</xsl:template>

	<xsl:template name="EdgeTemplate">
		<xsl:call-template name="DiagramElementTemplate" />

		<xsl:if test="@source">
			<xsl:attribute name="source"> <xsl:value-of select="@source" /> </xsl:attribute>
		</xsl:if>

		<xsl:if test="@target">
			<xsl:attribute name="target"> <xsl:value-of select="@target" /> </xsl:attribute>
		</xsl:if>

		<xsl:for-each select="waypoint">
			<di:waypoint>
				<xsl:call-template name="PointTemplate" />
			</di:waypoint>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="ShapeTemplate">
		<xsl:call-template name="NodeTemplate" />

		<xsl:for-each select="bounds">
			<dc:Bounds>
				<xsl:call-template name="BoundsTemplate" />
			</dc:Bounds>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="LabeledEdgeTemplate">
		<xsl:call-template name="EdgeTemplate" />

		<xsl:if test="@ownedLabel">
			<xsl:attribute name="ownedLabel"> <xsl:value-of select="@ownedLabel" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="LabelTemplate">
		<xsl:call-template name="NodeTemplate" />

		<xsl:for-each select="bounds">
			<dc:Bounds>
				<xsl:call-template name="BoundsTemplate" />
			</dc:Bounds>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="LabeledShapeTemplate">
		<xsl:call-template name="ShapeTemplate" />

		<xsl:if test="@ownedLabel">
			<xsl:attribute name="ownedLabel"> <xsl:value-of select="@ownedLabel" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="PlaneTemplate">
		<xsl:call-template name="NodeTemplate" />

		<xsl:for-each
			select="planeElement[contains(@xmi:type, 'BPMNEdge') or contains(@xsi:type, 'BPMNEdge')]">
			<bpmndi:BPMNEdge>
				<xsl:call-template name="BPMNEdgeTemplate" />
			</bpmndi:BPMNEdge>
		</xsl:for-each>
		<xsl:for-each
			select="planeElement[contains(@xmi:type, 'BPMNShape') or contains(@xsi:type, 'BPMNShape')]">
			<bpmndi:BPMNShape>
				<xsl:call-template name="BPMNShapeTemplate" />
			</bpmndi:BPMNShape>
		</xsl:for-each>

	</xsl:template>

	<xsl:template name="FontTemplate">
		<xsl:if test="@name">
			<xsl:attribute name="name"> <xsl:value-of select="@name" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@size">
			<xsl:attribute name="size"> <xsl:value-of select="@size" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isBold">
			<xsl:attribute name="isBold"> <xsl:value-of select="@isBold" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isItalic">
			<xsl:attribute name="isItalic"> <xsl:value-of select="@isItalic" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isUnderline">
			<xsl:attribute name="isUnderline"> <xsl:value-of select="@isUnderline" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@isStrikeThrough">
			<xsl:attribute name="isStrikeThrough"> <xsl:value-of select="@isStrikeThrough" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="PointTemplate">
		<xsl:if test="@x">
			<xsl:attribute name="x"> <xsl:value-of select="@x" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@y">
			<xsl:attribute name="y"> <xsl:value-of select="@y" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>

	<xsl:template name="BoundsTemplate">
		<xsl:if test="@x">
			<xsl:attribute name="x"> <xsl:value-of select="@x" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@y">
			<xsl:attribute name="y"> <xsl:value-of select="@y" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@width">
			<xsl:attribute name="width"> <xsl:value-of select="@width" /> </xsl:attribute>
		</xsl:if>
		<xsl:if test="@height">
			<xsl:attribute name="height"> <xsl:value-of select="@height" /> </xsl:attribute>
		</xsl:if>
	</xsl:template>


</xsl:stylesheet>
