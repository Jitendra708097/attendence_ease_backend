module.exports = (sequelize, DataTypes) => {
  const LeaveApprovalWorkflow = sequelize.define(
    'LeaveApprovalWorkflow',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      levels: {
        type: DataTypes.JSONB,
        defaultValue: [
          { level: 1, role: 'manager', scope: 'department' },
          { level: 2, role: 'admin', scope: 'org' },
        ],
      },
      auto_approve: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      is_default: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
    },
    {
      tableName: 'leave_approval_workflows',
      paranoid: true,
      underscored: true,
      indexes: [
        { fields: ['org_id', 'is_default'] },
        { fields: ['org_id', 'is_active'] },
      ],
    }
  );

  LeaveApprovalWorkflow.associate = (models) => {
    LeaveApprovalWorkflow.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    LeaveApprovalWorkflow.hasMany(models.LeavePolicy, {
      foreignKey: 'approval_workflow_id',
      as: 'policies',
    });
  };

  return LeaveApprovalWorkflow;
};
